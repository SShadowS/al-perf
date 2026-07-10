import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { LifecycleStore } from "../../src/lifecycle/store.js";
import { closeLifecycleStoreForTest } from "../../web/lifecycle-db.js";

const TEST_DATA = mkdtempSync(join(tmpdir(), "alperf-lifecycle-ingest-"));
process.env.AL_PERF_DATA_DIR = TEST_DATA;
process.env.AL_PERF_POC_SECRET = "test-secret-1234";
// PORT shared with prior poc-* tests (Bun module cache).
process.env.PORT ??= "3999";

const { server } = await import("../../web/server.ts");
const BASE = `http://localhost:${server.port}`;

afterAll(() => {
	delete process.env.AL_PERF_LIFECYCLE;
	// The ingest handler's singleton keeps lifecycle.sqlite's WAL handle open
	// for the process lifetime; close it here or rmSync fails with EBUSY on
	// Windows.
	closeLifecycleStoreForTest(TEST_DATA);
	rmSync(TEST_DATA, { recursive: true, force: true });
});

const GUID_OFF = "550e8400-e29b-41d4-a716-446655440201";
const GUID_ON = "550e8400-e29b-41d4-a716-446655440202";
const GUID_THROW = "550e8400-e29b-41d4-a716-446655440203";

async function registerTenant(tenantCode: string): Promise<string> {
	const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
	const publicXml = `<RSAKeyValue><Modulus>${Buffer.from(jwk.n, "base64url").toString("base64")}</Modulus><Exponent>${Buffer.from(jwk.e, "base64url").toString("base64")}</Exponent></RSAKeyValue>`;
	const res = await fetch(`${BASE}/api/tenants/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			tenantCode,
			sharedSecret: "test-secret-1234",
			publicKeyXml: publicXml,
		}),
	});
	const { tenantToken } = (await res.json()) as { tenantToken: string };
	return tenantToken;
}

async function postIngest(
	tenantCode: string,
	token: string,
	activityId: string,
	manifestOverrides: Record<string, unknown> = {},
) {
	const profilePath = resolve(
		import.meta.dir,
		"../fixtures/instrumentation-minimal.alcpuprofile",
	);
	const manifest = {
		activityId,
		activityType: "Background",
		scheduleId: "nightly-job",
		captureKind: "sampling",
		startTime: "2026-07-09T01:00:00Z",
		...manifestOverrides,
	};
	const fd = new FormData();
	fd.append(
		"manifest",
		new Blob([JSON.stringify(manifest)], { type: "application/json" }),
		"manifest.json",
	);
	fd.append(
		"profile",
		new Blob([readFileSync(profilePath)], { type: "application/octet-stream" }),
		"p.alcpuprofile",
	);
	return fetch(`${BASE}/api/ingest`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"x-tenant-id": tenantCode,
			"x-idempotency-key": activityId,
		},
		body: fd,
	});
}

describe("ingest lifecycle hook (AL_PERF_LIFECYCLE)", () => {
	it("default OFF: successful ingest writes no lifecycle run", async () => {
		delete process.env.AL_PERF_LIFECYCLE;
		const token = await registerTenant("lcoff");
		const res = await postIngest("lcoff", token, GUID_OFF);
		expect(res.status).toBe(202);
		expect(existsSync(join(TEST_DATA, "lifecycle.sqlite"))).toBe(false);
	});

	it("AL_PERF_LIFECYCLE=1: successful ingest records a lifecycle run keyed to manifest metadata", async () => {
		process.env.AL_PERF_LIFECYCLE = "1";
		const token = await registerTenant("lcon");
		const res = await postIngest("lcon", token, GUID_ON);
		expect(res.status).toBe(202);
		const store = new LifecycleStore(join(TEST_DATA, "lifecycle.sqlite"));
		const run = store.getRun("lcon", GUID_ON);
		expect(run).not.toBeNull();
		expect(run?.stream).toBe("nightly-job");
		expect(run?.captureKind).toBe("sampling");
		// evaluateRun canonicalizes captureTime via Date#toISOString (always
		// .000 millis) — see test/lifecycle/evaluate.test.ts's canonicalization
		// suite for the documented, deliberate behavior this mirrors.
		expect(run?.captureTime).toBe("2026-07-09T01:00:00.000Z");
		store.close();
	});

	it("AL_PERF_LIFECYCLE=1: a throwing evaluation never fails the ingest", async () => {
		process.env.AL_PERF_LIFECYCLE = "1";
		const token = await registerTenant("lcthrow");
		// evaluateRun's canonicalCaptureTime throws on an unparseable
		// captureTime — a real forcing function for the try/catch around the
		// lifecycle hook, not a mock.
		const res = await postIngest("lcthrow", token, GUID_THROW, {
			startTime: "not-a-date",
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as { status: string };
		expect(body.status).toBe("stored");
	});
});
