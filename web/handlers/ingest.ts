import { existsSync, mkdirSync, writeFileSync } from "fs";
import { analyzeProfile } from "../../src/core/analyzer.ts";
import { isValidActivityId, isValidTenantCode, normalizeActivityId, resolveStoragePath } from "../storage.ts";
import { checkBearerToken, loadPocSecret } from "../poc-secret.ts";

export async function handleIngest(req: Request, dataDir: string): Promise<Response> {
	const auth = req.headers.get("authorization");
	const expected = loadPocSecret();
	if (!checkBearerToken(auth, expected)) {
		return jsonResponse(401, { error: "unauthorized" });
	}

	const tenantCode = req.headers.get("x-tenant-id");
	if (!tenantCode || !isValidTenantCode(tenantCode)) {
		return jsonResponse(400, { error: "invalid_tenant_id" });
	}

	const activityIdRaw = req.headers.get("x-idempotency-key");
	if (!activityIdRaw || !isValidActivityId(activityIdRaw)) {
		return jsonResponse(400, { error: "invalid_idempotency_key" });
	}
	const activityId = normalizeActivityId(activityIdRaw);

	// Verify tenant exists (was registered)
	const tenantFile = resolveStoragePath(dataDir, "tenants", `${tenantCode}.json`);
	if (!existsSync(tenantFile)) {
		return jsonResponse(404, { error: "tenant_not_registered" });
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
		manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
	} catch {
		return jsonResponse(400, { error: "manifest_not_json" });
	}

	// Persist manifest + profile bytes first so analyzeProfile can read profile.bin from disk.
	const profileDir = resolveStoragePath(
		dataDir,
		"storage",
		tenantCode,
		"profiles",
		activityId,
	);
	mkdirSync(profileDir, { recursive: true });

	const profilePath = resolveStoragePath(profileDir, "profile.bin");
	writeFileSync(resolveStoragePath(profileDir, "manifest.json"), manifestBytes);
	writeFileSync(profilePath, profileBytes);

	// Inline analysis (POC v0 — synchronous; analyzeProfile takes a file path).
	let analysisResult: unknown;
	try {
		analysisResult = await analyzeProfile(profilePath);
	} catch (err) {
		return jsonResponse(500, { error: "analyze_failed", detail: String(err) });
	}

	writeFileSync(
		resolveStoragePath(profileDir, "result.json"),
		JSON.stringify(analysisResult, null, 2),
	);

	const metrics = extractMetrics(manifest, analysisResult, profileBytes.byteLength);
	writeFileSync(
		resolveStoragePath(profileDir, "metrics.json"),
		JSON.stringify(metrics, null, 2),
	);

	return jsonResponse(202, { id: activityId, status: "stored" });
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
