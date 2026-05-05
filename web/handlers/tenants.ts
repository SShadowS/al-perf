import { existsSync, mkdirSync, writeFileSync } from "fs";
import { loadPocSecret } from "../poc-secret.ts";
import {
	isValidTenantCode,
	normalizeTenantCode,
	resolveStoragePath,
} from "../storage.ts";

interface RegisterRequest {
	tenantCode?: string;
	sharedSecret?: string;
	publicKeyXml?: string;
	tenantTag?: string;
}

export async function handleTenantRegister(
	req: Request,
	dataDir: string,
): Promise<Response> {
	let body: RegisterRequest;
	try {
		body = (await req.json()) as RegisterRequest;
	} catch {
		return new Response(JSON.stringify({ error: "invalid_json" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	const { tenantCode: tenantCodeRaw, sharedSecret, publicKeyXml } = body;

	if (!tenantCodeRaw || !isValidTenantCode(tenantCodeRaw)) {
		return new Response(JSON.stringify({ error: "invalid_tenant_code" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}
	const tenantCode = normalizeTenantCode(tenantCodeRaw);

	const expected = loadPocSecret();
	if (sharedSecret !== expected) {
		return new Response(JSON.stringify({ error: "invalid_secret" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}

	if (
		!publicKeyXml ||
		typeof publicKeyXml !== "string" ||
		publicKeyXml.length < 10
	) {
		return new Response(JSON.stringify({ error: "invalid_public_key" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	const tenantsDir = resolveStoragePath(dataDir, "tenants");
	mkdirSync(tenantsDir, { recursive: true });
	const tenantFile = resolveStoragePath(
		dataDir,
		"tenants",
		`${tenantCode}.json`,
	);

	if (existsSync(tenantFile)) {
		return new Response(
			JSON.stringify({ error: "tenant_already_registered" }),
			{
				status: 409,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	const record = {
		tenantCode,
		publicKeyXml,
		tenantTag: body.tenantTag ?? tenantCode,
		registeredAt: new Date().toISOString(),
	};
	writeFileSync(tenantFile, JSON.stringify(record, null, 2));

	return new Response(
		JSON.stringify({ tenantCode, registeredAt: record.registeredAt }),
		{
			status: 201,
			headers: { "Content-Type": "application/json" },
		},
	);
}
