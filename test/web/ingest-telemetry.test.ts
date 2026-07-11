/**
 * ingest-telemetry.test.ts — telemetry-ingest plan Task 4: `/api/ingest`
 * accepts a `telemetry-batch` JSON as the `profile` part (gzipped or plain),
 * sniffed from CONTENT (isTelemetryBatchDocument), and routes it around
 * profile analysis entirely. Mirrors the ir-json ingest harness
 * (test/web/ingest-irjson.test.ts) and the lifecycle hook harness
 * (test/web/lifecycle-ingest.test.ts).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LifecycleStore } from "../../src/lifecycle/store.ts";
import type {
	TelemetryBatchDocument,
	TelemetrySignal,
} from "../../src/types/telemetry.ts";
import { closeLifecycleStoreForTest } from "../../web/lifecycle-db.ts";

const TEST_DATA = mkdtempSync(join(tmpdir(), "alperf-ingest-telemetry-"));
process.env.AL_PERF_DATA_DIR = TEST_DATA;
process.env.AL_PERF_POC_SECRET = "test-secret-1234";
// PORT shared with prior poc-* tests (Bun module cache).
process.env.PORT ??= "3999";

const { server } = await import("../../web/server.ts");
const BASE = `http://localhost:${server.port}`;

/**
 * Windows-only flake guard (same as test/lifecycle/cli.test.ts): a WAL-mode
 * sqlite file's `-shm`/`-wal` mapping can stay transiently locked for a beat
 * after `.close()` returns — `fs.rmSync`'s built-in retry doesn't paper over
 * it under Bun on Windows, so retry by hand with a real await between tries.
 */
async function rmSyncRetrying(
	path: string,
	attempts = 10,
	delayMs = 200,
): Promise<void> {
	for (let i = 1; i <= attempts; i++) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (err) {
			if (i === attempts) throw err;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

afterAll(async () => {
	delete process.env.AL_PERF_LIFECYCLE;
	closeLifecycleStoreForTest(TEST_DATA);
	await rmSyncRetrying(TEST_DATA);
});

function signal(overrides: Partial<TelemetrySignal> = {}): TelemetrySignal {
	return {
		signalId: "RT0018",
		appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		appName: "My ISV App",
		objectType: "Codeunit",
		objectId: 50100,
		objectName: "Order Processor",
		methodName: "ProcessLine",
		count: 3,
		maxDurationMs: 12_000,
		avgDurationMs: 9_500,
		...overrides,
	};
}

function batch(
	signals: TelemetrySignal[],
	overrides: Partial<TelemetryBatchDocument> = {},
): TelemetryBatchDocument {
	return {
		schemaVersion: 1,
		payloadType: "telemetry-batch",
		windowStart: "2026-07-11T00:00:00.000Z",
		windowEnd: "2026-07-11T01:00:00.000Z",
		signals,
		...overrides,
	};
}

async function registerTenant(code: string): Promise<string> {
	const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
	const publicXml = `<RSAKeyValue><Modulus>${Buffer.from(jwk.n, "base64url").toString("base64")}</Modulus><Exponent>${Buffer.from(jwk.e, "base64url").toString("base64")}</Exponent></RSAKeyValue>`;
	const res = await fetch(`${BASE}/api/tenants/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			tenantCode: code,
			sharedSecret: "test-secret-1234",
			publicKeyXml: publicXml,
		}),
	});
	expect(res.status).toBe(201);
	const { tenantToken } = (await res.json()) as { tenantToken: string };
	return tenantToken;
}

function postIngest(
	token: string | null,
	tenant: string,
	idempotencyKey: string,
	payload: Uint8Array,
	manifest: Record<string, unknown>,
): Promise<Response> {
	const fd = new FormData();
	fd.append(
		"manifest",
		new Blob([JSON.stringify(manifest)], { type: "application/json" }),
		"manifest.json",
	);
	fd.append(
		"profile",
		new Blob([payload], { type: "application/json" }),
		"batch.json",
	);
	const headers: Record<string, string> = {
		"X-Tenant-Id": tenant,
		"X-Idempotency-Key": idempotencyKey,
	};
	if (token !== null) headers.Authorization = `Bearer ${token}`;
	return fetch(`${BASE}/api/ingest`, { method: "POST", headers, body: fd });
}

describe("POST /api/ingest with a telemetry-batch", () => {
	it("accepts a gzipped batch, stores it, and is idempotent on re-POST", async () => {
		const token = await registerTenant("tela");
		const doc = batch([signal()]);
		const gz = Bun.gzipSync(Buffer.from(JSON.stringify(doc), "utf8"));
		const key = "550e8400-e29b-41d4-a716-446655440301";

		const res = await postIngest(token, "tela", key, gz, {
			activityId: key,
			captureKind: "telemetry",
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			id: string;
			status: string;
			keyVersion: number;
		};
		expect(body.status).toBe("stored");
		expect(body.id).toBe(key);
		expect(Object.keys(body).sort()).toEqual(["id", "keyVersion", "status"]);

		const profileDir = join(TEST_DATA, "storage", "tela", "profiles", key);
		expect(existsSync(join(profileDir, "blob.enc"))).toBe(true);
		expect(existsSync(join(profileDir, "result.enc"))).toBe(true);
		expect(existsSync(join(profileDir, "wrapped.bin"))).toBe(true);
		expect(existsSync(join(profileDir, "keyversion.txt"))).toBe(true);
		// No profile analysis performed: no temp plaintext, no analyzeProfile output.
		expect(existsSync(join(profileDir, "profile.bin"))).toBe(false);
		const metrics = JSON.parse(
			readFileSync(join(profileDir, "metrics.json"), "utf8"),
		);
		expect(metrics.captureKind).toBe("telemetry");
		expect(metrics.signalCount).toBe(1);

		// Idempotent re-POST -> duplicate, same key version, no reprocessing.
		const res2 = await postIngest(token, "tela", key, gz, {
			activityId: key,
			captureKind: "telemetry",
		});
		expect(res2.status).toBe(202);
		const body2 = (await res2.json()) as { status: string };
		expect(body2.status).toBe("duplicate");
	});

	it("accepts a plain (uncompressed) batch", async () => {
		const token = await registerTenant("telb");
		const doc = batch([signal({ signalId: "RT0005" })]);
		const key = "550e8400-e29b-41d4-a716-446655440302";
		const res = await postIngest(
			token,
			"telb",
			key,
			Buffer.from(JSON.stringify(doc), "utf8"),
			{ activityId: key, captureKind: "telemetry" },
		);
		expect(res.status).toBe(202);
		expect(((await res.json()) as { status: string }).status).toBe("stored");
	});

	// Runs BEFORE the AL_PERF_LIFECYCLE=1 test below: once that test creates
	// lifecycle.sqlite in this file's shared TEST_DATA dir, the file's mere
	// existence no longer proves "OFF writes no run" (matches the ordering
	// convention in test/web/lifecycle-ingest.test.ts).
	it("default OFF: a telemetry batch is stored but writes no lifecycle run", async () => {
		delete process.env.AL_PERF_LIFECYCLE;
		const token = await registerTenant("teld");
		const doc = batch([signal()]);
		const key = "550e8400-e29b-41d4-a716-446655440304";
		const res = await postIngest(
			token,
			"teld",
			key,
			Buffer.from(JSON.stringify(doc), "utf8"),
			{ activityId: key },
		);
		expect(res.status).toBe(202);
		expect(existsSync(join(TEST_DATA, "lifecycle.sqlite"))).toBe(false);
	});

	it("AL_PERF_LIFECYCLE=1: records a finding in the lifecycle DB, keyed by capture kind telemetry", async () => {
		process.env.AL_PERF_LIFECYCLE = "1";
		try {
			const token = await registerTenant("telc");
			const doc = batch([signal()], { windowEnd: "2026-07-11T02:00:00.000Z" });
			const key = "550e8400-e29b-41d4-a716-446655440303";
			const res = await postIngest(
				token,
				"telc",
				key,
				Buffer.from(JSON.stringify(doc), "utf8"),
				{ activityId: key, captureKind: "telemetry", scheduleId: "night-pull" },
			);
			expect(res.status).toBe(202);

			const store = new LifecycleStore(join(TEST_DATA, "lifecycle.sqlite"));
			const run = store.getRun("telc", key);
			expect(run).not.toBeNull();
			expect(run?.captureKind).toBe("telemetry");
			expect(run?.stream).toBe("night-pull");
			expect(run?.captureTime).toBe("2026-07-11T02:00:00.000Z");

			const findings = store.listFindings({ tenant: "telc" });
			expect(findings.length).toBe(1);
			expect(findings[0].source).toBe("telemetry");
			expect(findings[0].fingerprint.startsWith("telemetry:")).toBe(true);
			store.close();
		} finally {
			delete process.env.AL_PERF_LIFECYCLE;
		}
	});

	it("rejects a batch over the signal budget with 4xx naming the budget", async () => {
		const token = await registerTenant("tele");
		const manySignals = Array.from({ length: 10_001 }, (_, i) =>
			signal({ signalId: `RT${i}` }),
		);
		const doc = batch(manySignals);
		const key = "550e8400-e29b-41d4-a716-446655440305";
		const res = await postIngest(
			token,
			"tele",
			key,
			Buffer.from(JSON.stringify(doc), "utf8"),
			{ activityId: key },
		);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.message).toMatch(/10001 signals > 10000/);
	});

	it("rejects a malformed batch (unsupported schemaVersion) with 400 naming the parser's message", async () => {
		const token = await registerTenant("telf");
		const doc = { ...batch([signal()]), schemaVersion: 2 };
		const key = "550e8400-e29b-41d4-a716-446655440306";
		const res = await postIngest(
			token,
			"telf",
			key,
			Buffer.from(JSON.stringify(doc), "utf8"),
			{ activityId: key },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.message).toMatch(/schemaVersion 2/);
		// Rejected before any storage write.
		expect(
			existsSync(join(TEST_DATA, "storage", "telf", "profiles", key)),
		).toBe(false);
	});

	it("rejects a batch with an unparseable windowEnd with 400 — never reaches the stored-but-poisoned state", async () => {
		const token = await registerTenant("telh");
		const doc = batch([signal()], { windowEnd: "not-a-date" });
		const key = "550e8400-e29b-41d4-a716-446655440309";
		const res = await postIngest(
			token,
			"telh",
			key,
			Buffer.from(JSON.stringify(doc), "utf8"),
			{ activityId: key },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.message).toMatch(/windowEnd/);
		// Rejected before any storage write — no keyversion.txt ever lands, so
		// there is no duplicate-run guard blocking a corrected re-POST.
		expect(
			existsSync(join(TEST_DATA, "storage", "telh", "profiles", key)),
		).toBe(false);
	});

	it("still enforces auth: a telemetry batch without a bearer token is 401", async () => {
		await registerTenant("telg");
		const doc = batch([signal()]);
		const key = "550e8400-e29b-41d4-a716-446655440307";
		const res = await postIngest(
			null,
			"telg",
			key,
			Buffer.from(JSON.stringify(doc), "utf8"),
			{ activityId: key },
		);
		expect(res.status).toBe(401);
	});

	it("still enforces tenant registration: an unregistered tenant is 404 (legacy shared-secret path)", async () => {
		// The per-tenant bearer path can't distinguish "wrong token" from
		// "unregistered tenant" (both 401, by design — no tenant enumeration).
		// The legacy shared-secret path binds credential to the POC secret
		// alone, so it's the one that reaches the tenant-existence check.
		process.env.AL_PERF_ALLOW_SHARED_SECRET = "1";
		try {
			const doc = batch([signal()]);
			const key = "550e8400-e29b-41d4-a716-446655440308";
			const res = await postIngest(
				"test-secret-1234",
				"telnope",
				key,
				Buffer.from(JSON.stringify(doc), "utf8"),
				{ activityId: key },
			);
			expect(res.status).toBe(404);
		} finally {
			delete process.env.AL_PERF_ALLOW_SHARED_SECRET;
		}
	});
});

// ---------------------------------------------------------------------------
// AL_PERF_LIFECYCLE_CONFIG (telemetry-config-clienttype plan Task 2): the
// config file's telemetry.severity thresholds must reach the SAME
// parseTelemetryBatch call that determines the stored finding's severity, and
// a malformed file must fail BEFORE the keyversion.txt completion marker —
// never inside the lifecycle hook's swallowed try/catch, which would leave
// the batch stored-but-never-evaluated with no way to re-POST.
// ---------------------------------------------------------------------------

describe("POST /api/ingest telemetry-batch with AL_PERF_LIFECYCLE_CONFIG", () => {
	afterAll(() => {
		delete process.env.AL_PERF_LIFECYCLE;
		delete process.env.AL_PERF_LIFECYCLE_CONFIG;
	});

	it("a threshold-raising config file changes the stored finding's severity", async () => {
		process.env.AL_PERF_LIFECYCLE = "1";
		const configPath = join(TEST_DATA, "raise-rt0018.config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: {
					severity: { RT0018: { warningMs: 20_000, criticalMs: 50_000 } },
				},
			}),
		);
		process.env.AL_PERF_LIFECYCLE_CONFIG = configPath;
		try {
			const token = await registerTenant("telcfg1");
			// Default RT0018 thresholds (warningMs 10_000 / criticalMs 30_000):
			// 35s is critical. The raised thresholds above land it in warning.
			const doc = batch([signal({ maxDurationMs: 35_000 })], {
				windowEnd: "2026-07-11T03:00:00.000Z",
			});
			const key = "550e8400-e29b-41d4-a716-446655440310";
			const res = await postIngest(
				token,
				"telcfg1",
				key,
				Buffer.from(JSON.stringify(doc), "utf8"),
				{ activityId: key, captureKind: "telemetry" },
			);
			expect(res.status).toBe(202);

			const store = new LifecycleStore(join(TEST_DATA, "lifecycle.sqlite"));
			const findings = store.listFindings({ tenant: "telcfg1" });
			expect(findings).toHaveLength(1);
			expect(findings[0].severity).toBe("warning");
			store.close();
		} finally {
			delete process.env.AL_PERF_LIFECYCLE;
			delete process.env.AL_PERF_LIFECYCLE_CONFIG;
		}
	});

	it("a malformed config file fails the request and never marks the batch ingested; re-POST works after fixing the file", async () => {
		process.env.AL_PERF_LIFECYCLE = "1";
		const configPath = join(TEST_DATA, "malformed.config.json");
		writeFileSync(configPath, "{ not valid json");
		process.env.AL_PERF_LIFECYCLE_CONFIG = configPath;
		try {
			const token = await registerTenant("telcfg2");
			const doc = batch([signal()]);
			const key = "550e8400-e29b-41d4-a716-446655440311";
			const res = await postIngest(
				token,
				"telcfg2",
				key,
				Buffer.from(JSON.stringify(doc), "utf8"),
				{ activityId: key, captureKind: "telemetry" },
			);
			expect(res.status).toBeGreaterThanOrEqual(400);
			expect(res.status).toBeLessThan(600);
			expect(
				existsSync(
					join(
						TEST_DATA,
						"storage",
						"telcfg2",
						"profiles",
						key,
						"keyversion.txt",
					),
				),
			).toBe(false);

			// Fix the file and re-POST with the same idempotency key: no
			// duplicate-run guard was ever armed, so this must succeed.
			writeFileSync(configPath, JSON.stringify({}));
			const res2 = await postIngest(
				token,
				"telcfg2",
				key,
				Buffer.from(JSON.stringify(doc), "utf8"),
				{ activityId: key, captureKind: "telemetry" },
			);
			expect(res2.status).toBe(202);
			const body2 = (await res2.json()) as { status: string };
			expect(body2.status).toBe("stored");
		} finally {
			delete process.env.AL_PERF_LIFECYCLE;
			delete process.env.AL_PERF_LIFECYCLE_CONFIG;
		}
	});

	it("lifecycle OFF: a malformed config file is never even read — batch stores normally", async () => {
		// AL_PERF_LIFECYCLE deliberately left unset/OFF: evaluation never runs,
		// so a broken AL_PERF_LIFECYCLE_CONFIG file must not fail this ingest —
		// resolveGatedLifecycleConfig short-circuits to DEFAULT_LIFECYCLE_CONFIG
		// without ever calling loadLifecycleConfigFile.
		const configPath = join(TEST_DATA, "malformed-off.config.json");
		writeFileSync(configPath, "{ not valid json");
		process.env.AL_PERF_LIFECYCLE_CONFIG = configPath;
		try {
			const token = await registerTenant("telcfg3");
			const doc = batch([signal()]);
			const key = "550e8400-e29b-41d4-a716-446655440312";
			const res = await postIngest(
				token,
				"telcfg3",
				key,
				Buffer.from(JSON.stringify(doc), "utf8"),
				{ activityId: key, captureKind: "telemetry" },
			);
			expect(res.status).toBe(202);
			const body = (await res.json()) as { status: string };
			expect(body.status).toBe("stored");
		} finally {
			delete process.env.AL_PERF_LIFECYCLE_CONFIG;
		}
	});
});
