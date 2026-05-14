import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TEST_DATA = mkdtempSync(join(tmpdir(), "alperf-poc-tenants-"));
process.env.AL_PERF_DATA_DIR = TEST_DATA;
process.env.AL_PERF_POC_SECRET = "test-secret-1234";
// PORT is read by web/server.ts at module load. Bun caches that module across
// test files in a single run, so we set PORT only if no other test file has
// already chosen one. The actual port used by the live server is read back
// from `server.port` below — that's what fetches need to target.
process.env.PORT ??= "3999";

const { server } = await import("../../web/server.ts");
const BASE = `http://localhost:${server.port}`;

afterAll(() => {
	rmSync(TEST_DATA, { recursive: true, force: true });
	// Note: we deliberately do NOT call server.stop() here. The web/server.ts
	// module is cached across test files; stopping it here would break
	// server.test.ts when it runs alphabetically after this file. The other
	// server-using test files manage their own teardown.
});

describe("POST /api/tenants/register (POC)", () => {
	it("registers a fresh tenant", async () => {
		const res = await fetch(`${BASE}/api/tenants/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tenantCode: "poc",
				sharedSecret: "test-secret-1234",
				publicKeyXml:
					"<RSAKeyValue><Modulus>placeholder</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>",
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.tenantCode).toBe("poc");
	});

	it("rejects re-registration of same tenant", async () => {
		const res = await fetch(`${BASE}/api/tenants/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tenantCode: "poc",
				sharedSecret: "test-secret-1234",
				publicKeyXml: "<RSAKeyValue>...</RSAKeyValue>",
			}),
		});
		expect(res.status).toBe(409);
	});

	it("rejects bad tenantCode", async () => {
		const res = await fetch(`${BASE}/api/tenants/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tenantCode: "../etc",
				sharedSecret: "test-secret-1234",
				publicKeyXml: "<RSAKeyValue>...</RSAKeyValue>",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects wrong shared secret", async () => {
		const res = await fetch(`${BASE}/api/tenants/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tenantCode: "another",
				sharedSecret: "WRONG",
				publicKeyXml: "<RSAKeyValue>...</RSAKeyValue>",
			}),
		});
		expect(res.status).toBe(401);
	});
});
