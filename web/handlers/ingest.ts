import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { analyzeProfile } from "../../src/core/analyzer.ts";
import {
	isTelemetryBatchDocument,
	parseTelemetryBatch,
} from "../../src/core/telemetry-parser.ts";
import {
	DEFAULT_LIFECYCLE_CONFIG,
	type LifecycleConfig,
} from "../../src/lifecycle/config.ts";
import {
	loadLifecycleConfigFile,
	mergeLifecycleConfig,
} from "../../src/lifecycle/config-file.ts";
import { encryptBundle, type RsaJwk, xmlRsaToJwk } from "../crypto.ts";
import {
	checkBearerAgainstHash,
	checkBearerToken,
	loadPocSecret,
	sharedSecretAllowed,
} from "../poc-secret.ts";
import {
	isValidActivityId,
	isValidTenantCode,
	normalizeActivityId,
	normalizeTenantCode,
	resolveStoragePath,
} from "../storage.ts";

const KEY_VERSION_POC = "1";
const DEFAULT_MAX_PROFILE_BYTES = 134_217_728; // 128 MiB decompressed

interface TenantRecord {
	publicKeyXml?: string;
	tokenHash?: string;
}

/** Read AL_PERF_MAX_PROFILE_BYTES per request; fail closed (use the default) on junk. */
function resolveMaxProfileBytes(): number {
	const raw = process.env.AL_PERF_MAX_PROFILE_BYTES;
	if (raw === undefined) return DEFAULT_MAX_PROFILE_BYTES;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		console.error(
			`[ingest] invalid AL_PERF_MAX_PROFILE_BYTES=${JSON.stringify(raw)}; falling back to default ${DEFAULT_MAX_PROFILE_BYTES}`,
		);
		return DEFAULT_MAX_PROFILE_BYTES;
	}
	return parsed;
}

/**
 * Read AL_PERF_LIFECYCLE_CONFIG per request; unset → defaults. A malformed
 * file throws (propagated to the caller) — deliberately NOT caught here, so
 * every call site decides its own placement relative to the completion
 * marker instead of this helper silently degrading to defaults.
 */
function resolveLifecycleConfigFromEnv(): LifecycleConfig {
	const path = process.env.AL_PERF_LIFECYCLE_CONFIG;
	if (!path) return DEFAULT_LIFECYCLE_CONFIG;
	return mergeLifecycleConfig(
		DEFAULT_LIFECYCLE_CONFIG,
		loadLifecycleConfigFile(path) ?? {},
	);
}

/**
 * Resolve the effective LifecycleConfig for a request, gated on
 * AL_PERF_LIFECYCLE=1: evaluation is opt-in and OFF by default, so a broken
 * AL_PERF_LIFECYCLE_CONFIG file must never fail an ingest whose lifecycle
 * evaluation isn't even going to run — when OFF this always returns
 * DEFAULT_LIFECYCLE_CONFIG without touching the file at all. When ON, a
 * malformed file fails loud: the caller must check `instanceof Response`
 * and return it immediately, BEFORE any storage write (never inside the
 * downstream swallowed try/catch used for runtime evaluation errors).
 */
function resolveGatedLifecycleConfig(
	tenantCode: string,
	activityId: string,
): LifecycleConfig | Response {
	if (process.env.AL_PERF_LIFECYCLE !== "1") return DEFAULT_LIFECYCLE_CONFIG;
	try {
		return resolveLifecycleConfigFromEnv();
	} catch (err) {
		console.error(
			`[lifecycle] invalid AL_PERF_LIFECYCLE_CONFIG for tenant ${tenantCode} activity ${activityId}: ${err}`,
		);
		return jsonResponse(500, {
			error: "lifecycle_config_invalid",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

class ProfileTooLargeError extends Error {}

/**
 * Decompress gzip data using DecompressionStream, aborting the stream as soon
 * as the accumulated output exceeds maxSize — bounds the decompression itself
 * (gzip-bomb guard), not just the size of the finished buffer. Mirrors
 * inflateData in src/source/zip-extractor.ts.
 */
async function gunzipBounded(
	compressed: Uint8Array,
	maxSize: number,
): Promise<Buffer> {
	const ds = new DecompressionStream("gzip");
	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();

	// The writable side's write()/close() promises also reject when the
	// stream errors (e.g. malformed gzip); left unhandled, that crashes as an
	// unhandled rejection even though the readable side's rejection below is
	// caught. Swallow them here — the readable side is the source of truth.
	writer.write(compressed as BufferSource).catch(() => {});
	writer.close().catch(() => {});

	const chunks: Uint8Array[] = [];
	let totalLength = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		totalLength += value.length;
		if (totalLength > maxSize) {
			// Best-effort cancellation; report the size violation regardless of
			// whether cancel() itself resolves cleanly.
			try {
				await reader.cancel();
			} catch {}
			throw new ProfileTooLargeError(
				`Decompressed size exceeds limit of ${maxSize} bytes`,
			);
		}
	}

	const result = new Uint8Array(totalLength);
	let pos = 0;
	for (const chunk of chunks) {
		result.set(chunk, pos);
		pos += chunk.length;
	}
	return Buffer.from(result);
}

export async function handleIngest(
	req: Request,
	dataDir: string,
): Promise<Response> {
	const tenantCodeRaw = req.headers.get("x-tenant-id");
	if (!tenantCodeRaw || !isValidTenantCode(tenantCodeRaw)) {
		return jsonResponse(400, { error: "invalid_tenant_id" });
	}
	const tenantCode = normalizeTenantCode(tenantCodeRaw);

	const activityIdRaw = req.headers.get("x-idempotency-key");
	if (!activityIdRaw || !isValidActivityId(activityIdRaw)) {
		return jsonResponse(400, { error: "invalid_idempotency_key" });
	}
	const activityId = normalizeActivityId(activityIdRaw);

	const tenantFile = resolveStoragePath(
		dataDir,
		"tenants",
		`${tenantCode}.json`,
	);
	let tenantRecord: TenantRecord | undefined;
	if (existsSync(tenantFile)) {
		tenantRecord = JSON.parse(readFileSync(tenantFile, "utf8")) as TenantRecord;
	}

	// Auth binds tenant to credential: the bearer must be the tenant's own token.
	// The legacy shared-secret path (bearer == POC secret, tenant from header) is
	// opt-in via AL_PERF_ALLOW_SHARED_SECRET=1 for clients not yet migrated.
	const auth = req.headers.get("authorization");
	const tokenOk = tenantRecord?.tokenHash
		? checkBearerAgainstHash(auth, tenantRecord.tokenHash)
		: false;
	const legacyOk = sharedSecretAllowed()
		? checkBearerToken(auth, loadPocSecret())
		: false;
	if (!tokenOk && !legacyOk) {
		return jsonResponse(401, { error: "unauthorized" });
	}

	if (!tenantRecord) {
		return jsonResponse(404, { error: "tenant_not_registered" });
	}
	if (!tenantRecord.publicKeyXml) {
		return jsonResponse(409, { error: "tenant_missing_public_key" });
	}
	let jwk: RsaJwk;
	try {
		jwk = xmlRsaToJwk(tenantRecord.publicKeyXml);
	} catch (err) {
		console.error(
			`[ingest] invalid public key for tenant ${tenantCode}: ${err}`,
		);
		return jsonResponse(409, { error: "tenant_public_key_invalid" });
	}

	const profileDir = resolveStoragePath(
		dataDir,
		"storage",
		tenantCode,
		"profiles",
		activityId,
	);

	// Idempotency: a completed ingest (keyversion.txt is written last) makes a
	// repeat POST a no-op — never a re-analysis or overwrite.
	const completedMarker = resolveStoragePath(profileDir, "keyversion.txt");
	if (existsSync(completedMarker)) {
		const keyVersion = readFileSync(completedMarker, "utf8").trim();
		return jsonResponse(202, {
			id: activityId,
			status: "duplicate",
			keyVersion: Number(keyVersion || KEY_VERSION_POC),
		});
	}

	let formData: FormData;
	try {
		formData = await req.formData();
	} catch {
		return jsonResponse(400, { error: "invalid_multipart" });
	}

	const manifestPart = formData.get("manifest");
	const profilePart = formData.get("profile");
	if (!(manifestPart instanceof Blob) || !(profilePart instanceof Blob)) {
		return jsonResponse(400, { error: "missing_parts" });
	}

	const manifestBytes = Buffer.from(await manifestPart.arrayBuffer());
	let profileBytes = Buffer.from(await profilePart.arrayBuffer());

	// Size budget on DECOMPRESSED bytes (gzip-bomb guard). Read per request so
	// tests can override; the invocation-count budget lives in the parser.
	const maxProfileBytes = resolveMaxProfileBytes();

	// gzip transfer encoding, detected by content (magic bytes 0x1f 0x8b) —
	// multipart part headers are not visible through req.formData(), so the
	// contract is: gzip the profile bytes themselves before appending the part.
	// Decompression is bounded incrementally (gunzipBounded aborts the stream
	// once output exceeds maxProfileBytes) so a compressed bomb can't force
	// unbounded synchronous allocation before the budget check runs.
	if (
		profileBytes.length >= 2 &&
		profileBytes[0] === 0x1f &&
		profileBytes[1] === 0x8b
	) {
		try {
			profileBytes = await gunzipBounded(profileBytes, maxProfileBytes);
		} catch (err) {
			if (err instanceof ProfileTooLargeError) {
				return jsonResponse(413, { error: "payload_too_large" });
			}
			return jsonResponse(400, { error: "invalid_gzip" });
		}
	}

	// Belt-and-suspenders: also covers plain (non-gzip) uploads.
	if (profileBytes.length > maxProfileBytes) {
		return jsonResponse(413, { error: "payload_too_large" });
	}

	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return jsonResponse(400, { error: "manifest_not_json" });
	}

	const captureKind = manifest.captureKind;
	if (
		captureKind !== undefined &&
		captureKind !== "sampling" &&
		captureKind !== "instrumentation" &&
		captureKind !== "telemetry"
	) {
		return jsonResponse(400, { error: "invalid_capture_kind" });
	}

	// Telemetry batches are sniffed from CONTENT (isTelemetryBatchDocument),
	// never from the manifest's captureKind — mirrors how ir-json vs
	// .alcpuprofile is sniffed from content in parseProfile. They skip
	// analysis entirely (no analyzeProfile, no flamegraph, no stored
	// AnalysisResult beyond the batch itself) and evaluate through the
	// lifecycle engine via evaluateTelemetryBatch instead of evaluateRun.
	const profileText = profileBytes.toString("utf8");
	if (isTelemetryBatchDocument(profileText)) {
		return handleTelemetryIngest({
			dataDir,
			tenantCode,
			activityId,
			profileDir,
			profileText,
			profileBytes,
			manifestBytes,
			manifest,
			jwk,
		});
	}

	// Resolve the lifecycle config BEFORE any storage write: only the
	// AL_PERF_LIFECYCLE=1 hook below consumes it, but a malformed
	// AL_PERF_LIFECYCLE_CONFIG file must fail the request outright (never
	// swallowed into the hook's own try/catch, which exists for RUNTIME
	// evaluation errors on an already-stored profile, not operator
	// misconfiguration) — checking it here, before keyversion.txt is ever
	// written, keeps a bad config file from poisoning re-POSTs.
	const lifecycleConfigOrResponse = resolveGatedLifecycleConfig(
		tenantCode,
		activityId,
	);
	if (lifecycleConfigOrResponse instanceof Response) {
		return lifecycleConfigOrResponse;
	}
	const lifecycleConfig = lifecycleConfigOrResponse;

	mkdirSync(profileDir, { recursive: true });

	// Write profile.bin to disk so analyzeProfile can read it as a filePath, then delete after.
	const tempProfilePath = resolveStoragePath(profileDir, "profile.bin");
	writeFileSync(tempProfilePath, profileBytes);

	let analysisResult: unknown;
	try {
		analysisResult = await analyzeProfile(tempProfilePath);
	} catch (err) {
		try {
			unlinkSync(tempProfilePath);
		} catch {}
		console.error(
			`[ingest] analysis failed for tenant ${tenantCode} activity ${activityId}: ${err}`,
		);
		return jsonResponse(500, { error: "analyze_failed" });
	}

	const resultBytes = Buffer.from(JSON.stringify(analysisResult), "utf8");

	const bundle = encryptBundle(profileBytes, resultBytes, manifestBytes, jwk);

	writeFileSync(resolveStoragePath(profileDir, "manifest.json"), manifestBytes);
	writeFileSync(
		resolveStoragePath(profileDir, "metrics.json"),
		JSON.stringify(
			extractMetrics(manifest, analysisResult, profileBytes.byteLength),
			null,
			2,
		),
	);
	writeFileSync(resolveStoragePath(profileDir, "wrapped.bin"), bundle.wrapped);
	writeFileSync(
		resolveStoragePath(profileDir, "blob.enc"),
		Buffer.concat([bundle.blob.iv, bundle.blob.tag, bundle.blob.ciphertext]),
	);
	writeFileSync(
		resolveStoragePath(profileDir, "result.enc"),
		Buffer.concat([
			bundle.result.iv,
			bundle.result.tag,
			bundle.result.ciphertext,
		]),
	);
	writeFileSync(
		resolveStoragePath(profileDir, "keyversion.txt"),
		KEY_VERSION_POC,
	);

	// Delete temp plaintext profile.bin (v1 invariant: only ciphertext at rest).
	try {
		unlinkSync(tempProfilePath);
	} catch {}

	// Lifecycle evaluation (phase 3) — opt-in via AL_PERF_LIFECYCLE=1 (read
	// per request) so the POC ingest behavior is byte-unchanged by default.
	// Errors are logged and never fail the ingest: the profile is already
	// stored and reanalyzable.
	if (process.env.AL_PERF_LIFECYCLE === "1") {
		try {
			const { getLifecycleStore } = await import("../lifecycle-db.ts");
			const { evaluateRun } = await import("../../src/lifecycle/evaluate.ts");
			const result =
				analysisResult as import("../../src/output/types.ts").AnalysisResult;
			const captureKind =
				manifest.captureKind === "instrumentation" ||
				manifest.captureKind === "sampling"
					? manifest.captureKind
					: (result.meta.captureKind ?? result.meta.profileType);
			evaluateRun(
				getLifecycleStore(dataDir),
				result,
				{
					tenant: tenantCode,
					stream:
						typeof manifest.scheduleId === "string" &&
						manifest.scheduleId !== ""
							? manifest.scheduleId
							: "adhoc",
					profileId: activityId,
					captureKind,
					captureTime:
						typeof manifest.startTime === "string"
							? manifest.startTime
							: new Date().toISOString(),
					versions: parseManifestVersions(manifest),
				},
				lifecycleConfig,
			);
		} catch (err) {
			console.error(
				`[lifecycle] evaluation failed for tenant ${tenantCode} activity ${activityId}: ${err}`,
			);
		}
	}

	return jsonResponse(202, {
		id: activityId,
		status: "stored",
		keyVersion: Number(KEY_VERSION_POC),
	});
}

interface TelemetryIngestArgs {
	dataDir: string;
	tenantCode: string;
	activityId: string;
	profileDir: string;
	profileText: string;
	profileBytes: Buffer;
	manifestBytes: Buffer;
	manifest: Record<string, unknown>;
	jwk: RsaJwk;
}

/**
 * Telemetry-batch ingest: validates the batch (fail-closed, unconditionally —
 * this is the request's only shape check, independent of AL_PERF_LIFECYCLE)
 * before touching disk, then stores the raw batch + manifest via the same
 * encrypted-bundle path profiles use. There is no AnalysisResult to store as
 * "result" (an empty buffer stands in); lifecycle evaluation is opt-in via
 * evaluateTelemetryBatch, mirroring the profile path's evaluateRun hook.
 */
async function handleTelemetryIngest(
	args: TelemetryIngestArgs,
): Promise<Response> {
	const {
		dataDir,
		tenantCode,
		activityId,
		profileDir,
		profileText,
		profileBytes,
		manifestBytes,
		manifest,
		jwk,
	} = args;

	let batchJson: unknown;
	try {
		batchJson = JSON.parse(profileText);
	} catch {
		return jsonResponse(400, {
			error: "invalid_telemetry_batch",
			message: "telemetry-batch: invalid JSON",
		});
	}

	// AL_PERF_LIFECYCLE_CONFIG's telemetry.severity block must drive the SAME
	// severity classification used below (and, if AL_PERF_LIFECYCLE=1, the
	// stored finding's severity) — resolved here, alongside the parse, and
	// BEFORE any storage write, so a malformed file fails the request outright
	// rather than landing in the lifecycle hook's swallowed try/catch further
	// down (which exists for runtime evaluation errors, not a bad config
	// file). Gated on AL_PERF_LIFECYCLE=1 like the profile path: with
	// evaluation OFF, a broken config file must not fail an ingest that never
	// evaluates anything — parseTelemetryBatch just gets DEFAULT_LIFECYCLE_CONFIG.
	const lifecycleConfigOrResponse = resolveGatedLifecycleConfig(
		tenantCode,
		activityId,
	);
	if (lifecycleConfigOrResponse instanceof Response) {
		return lifecycleConfigOrResponse;
	}
	const lifecycleConfig = lifecycleConfigOrResponse;

	let parsed: ReturnType<typeof parseTelemetryBatch>;
	try {
		parsed = parseTelemetryBatch(batchJson, lifecycleConfig);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return jsonResponse(400, { error: "invalid_telemetry_batch", message });
	}

	mkdirSync(profileDir, { recursive: true });

	// No AnalysisResult beyond the batch itself: the "result" half of the
	// encrypted bundle is an empty buffer rather than a synthesized payload.
	const bundle = encryptBundle(
		profileBytes,
		Buffer.alloc(0),
		manifestBytes,
		jwk,
	);

	writeFileSync(resolveStoragePath(profileDir, "manifest.json"), manifestBytes);
	writeFileSync(
		resolveStoragePath(profileDir, "metrics.json"),
		JSON.stringify(
			{
				activityId: manifest.activityId,
				scheduleId: manifest.scheduleId,
				activityType: manifest.activityType,
				captureKind: "telemetry",
				sourceFormat: "telemetry-batch",
				windowEnd: parsed.windowEnd,
				signalCount: parsed.signalCount,
				profileSize: profileBytes.byteLength,
				analyzedAt: new Date().toISOString(),
			},
			null,
			2,
		),
	);
	writeFileSync(resolveStoragePath(profileDir, "wrapped.bin"), bundle.wrapped);
	writeFileSync(
		resolveStoragePath(profileDir, "blob.enc"),
		Buffer.concat([bundle.blob.iv, bundle.blob.tag, bundle.blob.ciphertext]),
	);
	writeFileSync(
		resolveStoragePath(profileDir, "result.enc"),
		Buffer.concat([
			bundle.result.iv,
			bundle.result.tag,
			bundle.result.ciphertext,
		]),
	);
	writeFileSync(
		resolveStoragePath(profileDir, "keyversion.txt"),
		KEY_VERSION_POC,
	);

	// Lifecycle evaluation (opt-in, matches the profile path's hook): errors
	// are logged and never fail the ingest — the batch is already stored.
	if (process.env.AL_PERF_LIFECYCLE === "1") {
		try {
			const { getLifecycleStore } = await import("../lifecycle-db.ts");
			const { evaluateTelemetryBatch } = await import(
				"../../src/lifecycle/telemetry.ts"
			);
			evaluateTelemetryBatch(
				getLifecycleStore(dataDir),
				batchJson,
				{
					tenant: tenantCode,
					stream:
						typeof manifest.scheduleId === "string" &&
						manifest.scheduleId !== ""
							? manifest.scheduleId
							: "telemetry",
					profileId: activityId,
				},
				lifecycleConfig,
			);
		} catch (err) {
			console.error(
				`[lifecycle] telemetry evaluation failed for tenant ${tenantCode} activity ${activityId}: ${err}`,
			);
		}
	}

	return jsonResponse(202, {
		id: activityId,
		status: "stored",
		keyVersion: Number(KEY_VERSION_POC),
	});
}

function extractMetrics(
	manifest: Record<string, unknown>,
	analysisResult: unknown,
	profileSize: number,
): Record<string, unknown> {
	const r = (analysisResult ?? {}) as Record<string, unknown>;
	const meta = (r.meta ?? {}) as Record<string, unknown>;
	const summary = (r.summary ?? {}) as Record<string, unknown>;
	return {
		activityId: manifest.activityId,
		scheduleId: manifest.scheduleId,
		activityType: manifest.activityType,
		captureKind: manifest.captureKind ?? meta.captureKind ?? null,
		sourceFormat: meta.sourceFormat ?? null,
		startTime: manifest.startTime,
		activityDuration: manifest.activityDuration,
		alExecutionDuration: manifest.alExecutionDuration,
		sqlCallDuration: manifest.sqlCallDuration,
		sqlCallCount: manifest.sqlCallCount,
		httpCallDuration: manifest.httpCallDuration,
		httpCallCount: manifest.httpCallCount,
		totalDuration: meta.totalDuration ?? null,
		nodeCount: meta.nodeCount ?? null,
		healthScore: summary.healthScore ?? null,
		profileSize,
		analyzedAt: new Date().toISOString(),
	};
}

/**
 * Versions from the ingest manifest (spec §2 ingest body mentions
 * appVersions[]; today's al-perf-bc manifests don't send it yet — this is
 * forward-compatible and returns undefined until producers do).
 */
function parseManifestVersions(
	manifest: Record<string, unknown>,
):
	| { platform?: string; apps?: Array<{ id: string; version: string }> }
	| undefined {
	const platform =
		typeof manifest.platformVersion === "string"
			? manifest.platformVersion
			: undefined;
	const apps = Array.isArray(manifest.appVersions)
		? manifest.appVersions.filter(
				(a): a is { id: string; version: string } =>
					typeof a === "object" &&
					a !== null &&
					typeof (a as { id?: unknown }).id === "string" &&
					typeof (a as { version?: unknown }).version === "string",
			)
		: undefined;
	if (!platform && !apps?.length) return undefined;
	return { platform, apps };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
