import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { analyzeProfile } from "../../src/core/analyzer.ts";
import { encryptBundle, type RsaJwk, xmlRsaToJwk } from "../crypto.ts";
import { checkBearerToken, loadPocSecret } from "../poc-secret.ts";
import {
	isValidActivityId,
	isValidTenantCode,
	normalizeActivityId,
	normalizeTenantCode,
	resolveStoragePath,
} from "../storage.ts";

const KEY_VERSION_POC = "1";

export async function handleIngest(
	req: Request,
	dataDir: string,
): Promise<Response> {
	const auth = req.headers.get("authorization");
	if (!checkBearerToken(auth, loadPocSecret())) {
		return jsonResponse(401, { error: "unauthorized" });
	}

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
	if (!existsSync(tenantFile)) {
		return jsonResponse(404, { error: "tenant_not_registered" });
	}

	const tenantRecord = JSON.parse(readFileSync(tenantFile, "utf8")) as {
		publicKeyXml?: string;
	};
	if (!tenantRecord.publicKeyXml) {
		return jsonResponse(409, { error: "tenant_missing_public_key" });
	}
	let jwk: RsaJwk;
	try {
		jwk = xmlRsaToJwk(tenantRecord.publicKeyXml);
	} catch (err) {
		return jsonResponse(409, {
			error: "tenant_public_key_invalid",
			detail: String(err),
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
	const profileBytes = Buffer.from(await profilePart.arrayBuffer());

	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return jsonResponse(400, { error: "manifest_not_json" });
	}

	const profileDir = resolveStoragePath(
		dataDir,
		"storage",
		tenantCode,
		"profiles",
		activityId,
	);
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
		return jsonResponse(500, { error: "analyze_failed", detail: String(err) });
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

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
