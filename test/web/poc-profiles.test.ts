import { afterAll, describe, expect, it } from "bun:test";
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
	await fetch(`${BASE}/api/tenants/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			tenantCode: "poc",
			sharedSecret: "test-secret-1234",
			publicKeyXml: "<RSAKeyValue>x</RSAKeyValue>",
		}),
	});

	const profilePath = resolve(import.meta.dir, "../fixtures/instrumentation-minimal.alcpuprofile");
	const profileData = readFileSync(profilePath);

	const fd = new FormData();
	fd.append("manifest", new Blob([JSON.stringify({
		activityId: VALID_GUID,
		activityType: "Background",
		startTime: new Date().toISOString(),
	})], { type: "application/json" }), "manifest.json");
	fd.append("profile", new Blob([profileData], { type: "application/octet-stream" }), "p.alcpuprofile");

	await fetch(`${BASE}/api/ingest`, {
		method: "POST",
		headers: {
			"Authorization": "Bearer test-secret-1234",
			"X-Tenant-Id": "poc",
			"X-Idempotency-Key": VALID_GUID,
		},
		body: fd,
	});
}

describe("GET /api/profiles/{activityId} (POC v0 plaintext)", () => {
	it("returns the original profile bytes", async () => {
		await setupAndIngest();
		const res = await fetch(`${BASE}/api/profiles/${VALID_GUID}?tenant=poc`, {
			headers: { "Authorization": "Bearer test-secret-1234" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		const blob = await res.arrayBuffer();
		expect(blob.byteLength).toBeGreaterThan(0);
	});

	it("returns 404 for unknown activityId", async () => {
		const res = await fetch(`${BASE}/api/profiles/00000000-0000-0000-0000-000000000000?tenant=poc`, {
			headers: { "Authorization": "Bearer test-secret-1234" },
		});
		expect(res.status).toBe(404);
	});

	it("rejects missing bearer", async () => {
		const res = await fetch(`${BASE}/api/profiles/${VALID_GUID}?tenant=poc`);
		expect(res.status).toBe(401);
	});

	it("rejects bad activityId", async () => {
		const res = await fetch(`${BASE}/api/profiles/not-a-guid?tenant=poc`, {
			headers: { "Authorization": "Bearer test-secret-1234" },
		});
		expect(res.status).toBe(400);
	});
});
