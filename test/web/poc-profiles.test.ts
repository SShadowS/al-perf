import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const TEST_DATA = mkdtempSync(join(tmpdir(), "alperf-poc-profiles-"));
process.env.AL_PERF_DATA_DIR = TEST_DATA;
process.env.AL_PERF_POC_SECRET = "test-secret-1234";
// PORT shared with prior poc-* tests (Bun module cache); see A3 test for rationale.
process.env.PORT ??= "3999";

const { server } = await import("../../web/server.ts");
const BASE = `http://localhost:${server.port}`;

afterAll(() => {
	rmSync(TEST_DATA, { recursive: true, force: true });
});

const VALID_GUID = "550e8400-e29b-41d4-a716-446655440000";

async function setupAndIngest() {
	const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
	const publicXml = `<RSAKeyValue><Modulus>${Buffer.from(jwk.n, "base64url").toString("base64")}</Modulus><Exponent>${Buffer.from(jwk.e, "base64url").toString("base64")}</Exponent></RSAKeyValue>`;

	await fetch(`${BASE}/api/tenants/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			tenantCode: "poc",
			sharedSecret: "test-secret-1234",
			publicKeyXml: publicXml,
		}),
	});

	const profilePath = resolve(
		import.meta.dir,
		"../fixtures/instrumentation-minimal.alcpuprofile",
	);
	const profileData = readFileSync(profilePath);

	const fd = new FormData();
	fd.append(
		"manifest",
		new Blob(
			[
				JSON.stringify({
					activityId: VALID_GUID,
					activityType: "Background",
					startTime: new Date().toISOString(),
				}),
			],
			{ type: "application/json" },
		),
		"manifest.json",
	);
	fd.append(
		"profile",
		new Blob([profileData], { type: "application/octet-stream" }),
		"p.alcpuprofile",
	);

	await fetch(`${BASE}/api/ingest`, {
		method: "POST",
		headers: {
			Authorization: "Bearer test-secret-1234",
			"X-Tenant-Id": "poc",
			"X-Idempotency-Key": VALID_GUID,
		},
		body: fd,
	});
}

describe("GET /api/profiles/{activityId} (POC v0 plaintext)", () => {
	it("returns ciphertext bundle + plaintext manifest", async () => {
		await setupAndIngest();
		const res = await fetch(`${BASE}/api/profiles/${VALID_GUID}?tenant=poc`, {
			headers: { Authorization: "Bearer test-secret-1234" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/json");
		const body = await res.json();
		expect(body.keyVersion).toBe(1);
		expect(typeof body.manifest).toBe("string"); // base64
		expect(typeof body.wrapped).toBe("string"); // base64
		expect(
			body.blob && body.blob.iv && body.blob.tag && body.blob.ciphertext,
		).toBeTruthy();
		expect(
			body.result &&
				body.result.iv &&
				body.result.tag &&
				body.result.ciphertext,
		).toBeTruthy();
		expect(body.metrics).toBeTruthy();
	});

	it("returns 404 for unknown activityId", async () => {
		const res = await fetch(
			`${BASE}/api/profiles/00000000-0000-0000-0000-000000000000?tenant=poc`,
			{
				headers: { Authorization: "Bearer test-secret-1234" },
			},
		);
		expect(res.status).toBe(404);
	});

	it("rejects missing bearer", async () => {
		const res = await fetch(`${BASE}/api/profiles/${VALID_GUID}?tenant=poc`);
		expect(res.status).toBe(401);
	});

	it("rejects bad activityId", async () => {
		const res = await fetch(`${BASE}/api/profiles/not-a-guid?tenant=poc`, {
			headers: { Authorization: "Bearer test-secret-1234" },
		});
		expect(res.status).toBe(400);
	});
});
