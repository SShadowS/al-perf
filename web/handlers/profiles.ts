import { existsSync, readFileSync } from "fs";
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

interface TenantRecord {
	tokenHash?: string;
}

export async function handleGetProfile(
	req: Request,
	url: URL,
	dataDir: string,
	activityIdRaw: string,
): Promise<Response> {
	if (!isValidActivityId(activityIdRaw)) {
		return jsonResponse(400, { error: "invalid_activity_id" });
	}
	const activityId = normalizeActivityId(activityIdRaw);

	const tenantCodeRaw = url.searchParams.get("tenant") ?? "";
	if (!isValidTenantCode(tenantCodeRaw)) {
		return jsonResponse(400, { error: "invalid_tenant" });
	}
	const tenantCode = normalizeTenantCode(tenantCodeRaw);

	// The tenant param only locates the record; access requires that tenant's
	// own token. Legacy shared-secret reads are opt-in (AL_PERF_ALLOW_SHARED_SECRET=1).
	const tenantFile = resolveStoragePath(
		dataDir,
		"tenants",
		`${tenantCode}.json`,
	);
	let tenantRecord: TenantRecord | undefined;
	if (existsSync(tenantFile)) {
		tenantRecord = JSON.parse(readFileSync(tenantFile, "utf8")) as TenantRecord;
	}

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
	const resultBytes = readFileSync(
		resolveStoragePath(profileDir, "result.enc"),
	);
	const manifestBytes = readFileSync(
		resolveStoragePath(profileDir, "manifest.json"),
	);
	const metricsBytes = readFileSync(
		resolveStoragePath(profileDir, "metrics.json"),
	);
	const keyVersionStr = readFileSync(
		resolveStoragePath(profileDir, "keyversion.txt"),
		"utf8",
	).trim();

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

function splitBundlePartBase64(file: Buffer): {
	iv: string;
	tag: string;
	ciphertext: string;
} {
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
