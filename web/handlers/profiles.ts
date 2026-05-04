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

	const profileFile = resolveStoragePath(
		dataDir,
		"storage",
		tenantCode,
		"profiles",
		activityId,
		"profile.bin",
	);
	if (!existsSync(profileFile)) {
		return jsonResponse(404, { error: "not_found" });
	}

	const data = readFileSync(profileFile);
	return new Response(data, {
		status: 200,
		headers: { "Content-Type": "application/octet-stream" },
	});
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
