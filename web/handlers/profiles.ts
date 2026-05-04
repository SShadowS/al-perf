import { existsSync, readFileSync } from "fs";
import { isValidActivityId, isValidTenantCode, normalizeActivityId, resolveStoragePath } from "../storage.ts";
import { checkBearerToken, loadPocSecret } from "../poc-secret.ts";

export async function handleGetProfile(
	req: Request,
	url: URL,
	dataDir: string,
	activityIdRaw: string,
): Promise<Response> {
	const auth = req.headers.get("authorization");
	if (!checkBearerToken(auth, loadPocSecret())) {
		return jsonResponse(401, { error: "unauthorized" });
	}

	if (!isValidActivityId(activityIdRaw)) {
		return jsonResponse(400, { error: "invalid_activity_id" });
	}
	const activityId = normalizeActivityId(activityIdRaw);

	const tenantCode = url.searchParams.get("tenant") ?? "";
	if (!isValidTenantCode(tenantCode)) {
		return jsonResponse(400, { error: "invalid_tenant" });
	}

	const profileDir = resolveStoragePath(
		dataDir,
		"storage",
		tenantCode,
		"profiles",
		activityId,
	);
	const wrappedFile = resolveStoragePath(profileDir, "wrapped.bin");
	if (!existsSync(wrappedFile)) {
		return jsonResponse(404, { error: "not_found" });
	}

	const wrapped = readFileSync(wrappedFile);
	const blobBytes = readFileSync(resolveStoragePath(profileDir, "blob.enc"));
	const resultBytes = readFileSync(resolveStoragePath(profileDir, "result.enc"));
	const manifestBytes = readFileSync(resolveStoragePath(profileDir, "manifest.json"));
	const metricsBytes = readFileSync(resolveStoragePath(profileDir, "metrics.json"));
	const keyVersionStr = readFileSync(resolveStoragePath(profileDir, "keyversion.txt"), "utf8").trim();

	const body = {
		keyVersion: Number(keyVersionStr),
		manifest: manifestBytes.toString("base64"),
		metrics: JSON.parse(metricsBytes.toString("utf8")),
		wrapped: wrapped.toString("base64"),
		blob: splitBundlePartBase64(blobBytes),
		result: splitBundlePartBase64(resultBytes),
	};

	return jsonResponse(200, body);
}

function splitBundlePartBase64(file: Buffer): { iv: string; tag: string; ciphertext: string } {
	return {
		iv: file.subarray(0, 16).toString("base64"),
		tag: file.subarray(16, 48).toString("base64"),
		ciphertext: file.subarray(48).toString("base64"),
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
