import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const TEST_DATA = mkdtempSync(join(tmpdir(), "alperf-poc-ingest-"));
process.env.AL_PERF_DATA_DIR = TEST_DATA;
process.env.AL_PERF_POC_SECRET = "test-secret-1234";
process.env.PORT ??= "3999";   // see Task A3 — Bun caches the server module across files; share the port

const { server } = await import("../../web/server.ts");
const BASE = `http://localhost:${server.port}`;

afterAll(() => {
	rmSync(TEST_DATA, { recursive: true, force: true });
});

async function registerPoc() {
	await fetch(`${BASE}/api/tenants/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			tenantCode: "poc",
			sharedSecret: "test-secret-1234",
			publicKeyXml: "<RSAKeyValue><Modulus>x</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>",
		}),
	});
}

function loadFixture(): Buffer {
	const profilePath = resolve(import.meta.dir, "../fixtures/instrumentation-minimal.alcpuprofile");
	return Buffer.from(readFileSync(profilePath));
}

const VALID_GUID = "550e8400-e29b-41d4-a716-446655440000";

function buildManifest(activityId = VALID_GUID) {
	return {
		activityId,
		activityType: "Background",
		activityDescription: "POC test activity",
		startTime: new Date().toISOString(),
		activityDuration: 1000,
		alExecutionDuration: 500,
		sqlCallDuration: 200,
		sqlCallCount: 5,
		httpCallDuration: 0,
		httpCallCount: 0,
		userName: "TEST",
		clientSessionId: 42,
		scheduleId: VALID_GUID,
		scheduleDescription: "test schedule",
	};
}

function buildFormData(activityId = VALID_GUID): FormData {
	const fd = new FormData();
	fd.append("manifest", new Blob([JSON.stringify(buildManifest(activityId))], { type: "application/json" }), "manifest.json");
	fd.append("profile", new Blob([loadFixture()], { type: "application/octet-stream" }), "profile.alcpuprofile");
	return fd;
}

describe("POST /api/ingest (POC v0 plaintext)", () => {
	it("accepts ingest with valid bearer + manifest + profile", async () => {
		await registerPoc();
		const fd = buildFormData();
		const res = await fetch(`${BASE}/api/ingest`, {
			method: "POST",
			headers: {
				"Authorization": "Bearer test-secret-1234",
				"X-Tenant-Id": "poc",
				"X-Idempotency-Key": VALID_GUID,
			},
			body: fd,
		});
		expect(res.status).toBe(202);
		const body = await res.json();
		expect(body.id).toBe(VALID_GUID);
		expect(body.status).toBe("stored");

		// Verify on-disk artifacts (v0: plaintext)
		const profileDir = join(TEST_DATA, "storage", "poc", "profiles", VALID_GUID);
		expect(existsSync(join(profileDir, "manifest.json"))).toBe(true);
		expect(existsSync(join(profileDir, "metrics.json"))).toBe(true);
		expect(existsSync(join(profileDir, "profile.bin"))).toBe(true);
		expect(existsSync(join(profileDir, "result.json"))).toBe(true);
	});

	it("rejects missing bearer", async () => {
		const res = await fetch(`${BASE}/api/ingest`, {
			method: "POST",
			headers: { "X-Tenant-Id": "poc", "X-Idempotency-Key": VALID_GUID },
			body: buildFormData(),
		});
		expect(res.status).toBe(401);
	});

	it("rejects bad activityId", async () => {
		const res = await fetch(`${BASE}/api/ingest`, {
			method: "POST",
			headers: {
				"Authorization": "Bearer test-secret-1234",
				"X-Tenant-Id": "poc",
				"X-Idempotency-Key": "not-a-guid",
			},
			body: buildFormData("not-a-guid"),
		});
		expect(res.status).toBe(400);
	});

	it("rejects unknown tenant", async () => {
		const res = await fetch(`${BASE}/api/ingest`, {
			method: "POST",
			headers: {
				"Authorization": "Bearer test-secret-1234",
				"X-Tenant-Id": "unknown",
				"X-Idempotency-Key": VALID_GUID,
			},
			body: buildFormData(),
		});
		expect(res.status).toBe(404);
	});
});
