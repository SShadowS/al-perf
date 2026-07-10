import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TEST_DATA = mkdtempSync(join(tmpdir(), "alperf-ingest-irjson-"));
process.env.AL_PERF_DATA_DIR = TEST_DATA;
process.env.AL_PERF_POC_SECRET = "test-secret-1234";
// PORT shared with prior poc-* tests (Bun module cache).
process.env.PORT ??= "3999";

const { server } = await import("../../web/server.ts");
const BASE = `http://localhost:${server.port}`;

afterAll(() => {
	rmSync(TEST_DATA, { recursive: true, force: true });
	delete process.env.AL_PERF_MAX_PROFILE_BYTES;
});

const IRJSON_BYTES = readFileSync("test/fixtures/irjson-minimal.ir.json");

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
	token: string,
	tenant: string,
	idempotencyKey: string,
	profile: Uint8Array,
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
		new Blob([profile], { type: "application/octet-stream" }),
		"p.ir.json",
	);
	return fetch(`${BASE}/api/ingest`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"X-Tenant-Id": tenant,
			"X-Idempotency-Key": idempotencyKey,
		},
		body: fd,
	});
}

describe("POST /api/ingest with ir-json", () => {
	it("accepts a gzipped ir-json profile and records captureKind + sourceFormat", async () => {
		const token = await registerTenant("irja");
		const gz = Bun.gzipSync(IRJSON_BYTES);
		const key = "550e8400-e29b-41d4-a716-446655440101";
		const res = await postIngest(token, "irja", key, gz, {
			activityId: key,
			captureKind: "instrumentation",
		});
		expect(res.status).toBe(202);

		const profileDir = join(TEST_DATA, "storage", "irja", "profiles", key);
		expect(existsSync(join(profileDir, "metrics.json"))).toBe(true);
		expect(existsSync(join(profileDir, "profile.bin"))).toBe(false);
		const metrics = JSON.parse(
			readFileSync(join(profileDir, "metrics.json"), "utf8"),
		);
		expect(metrics.captureKind).toBe("instrumentation");
		expect(metrics.sourceFormat).toBe("ir-json");
		// profileSize is the DECOMPRESSED payload size
		expect(metrics.profileSize).toBe(IRJSON_BYTES.byteLength);
	});

	it("accepts a plain (uncompressed) ir-json profile", async () => {
		const token = await registerTenant("irjb");
		const key = "550e8400-e29b-41d4-a716-446655440102";
		const res = await postIngest(token, "irjb", key, IRJSON_BYTES, {
			activityId: key,
		});
		expect(res.status).toBe(202);
		const metrics = JSON.parse(
			readFileSync(
				join(TEST_DATA, "storage", "irjb", "profiles", key, "metrics.json"),
				"utf8",
			),
		);
		// no manifest captureKind -> falls back to the analyzer's meta
		expect(metrics.captureKind).toBe("instrumentation");
	});

	it("rejects corrupt gzip with 400 invalid_gzip", async () => {
		const token = await registerTenant("irjc");
		const key = "550e8400-e29b-41d4-a716-446655440103";
		const corrupt = new Uint8Array([0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03]);
		const res = await postIngest(token, "irjc", key, corrupt, {
			activityId: key,
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"invalid_gzip",
		);
	});

	it("rejects decompressed payloads over AL_PERF_MAX_PROFILE_BYTES with 413", async () => {
		const token = await registerTenant("irjd");
		const key = "550e8400-e29b-41d4-a716-446655440104";
		process.env.AL_PERF_MAX_PROFILE_BYTES = "1024";
		try {
			const gz = Bun.gzipSync(IRJSON_BYTES); // decompressed ~5 KB > 1024
			const res = await postIngest(token, "irjd", key, gz, {
				activityId: key,
			});
			expect(res.status).toBe(413);
			expect(((await res.json()) as { error: string }).error).toBe(
				"payload_too_large",
			);
		} finally {
			delete process.env.AL_PERF_MAX_PROFILE_BYTES;
		}
	});

	it("rejects an invalid manifest captureKind with 400", async () => {
		const token = await registerTenant("irje");
		const key = "550e8400-e29b-41d4-a716-446655440105";
		const res = await postIngest(token, "irje", key, IRJSON_BYTES, {
			activityId: key,
			captureKind: "bogus",
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"invalid_capture_kind",
		);
	});

	it("fails closed on a non-numeric AL_PERF_MAX_PROFILE_BYTES (falls back to the default, still rejects oversized)", async () => {
		const token = await registerTenant("irjf");
		const key = "550e8400-e29b-41d4-a716-446655440106";
		process.env.AL_PERF_MAX_PROFILE_BYTES = "banana";
		try {
			// 1 byte over the 128 MiB default — proves Number("banana") -> NaN
			// does not silently disable the budget (length > NaN is always false).
			const big = Buffer.alloc(134_217_729);
			const gz = Bun.gzipSync(big);
			const res = await postIngest(token, "irjf", key, gz, {
				activityId: key,
			});
			expect(res.status).toBe(413);
			expect(((await res.json()) as { error: string }).error).toBe(
				"payload_too_large",
			);
		} finally {
			delete process.env.AL_PERF_MAX_PROFILE_BYTES;
		}
	});

	it("bounds decompression incrementally — a 2 MiB zero payload trips a 1 MiB cap without full inflation", async () => {
		const token = await registerTenant("irjg");
		const key = "550e8400-e29b-41d4-a716-446655440107";
		process.env.AL_PERF_MAX_PROFILE_BYTES = String(1024 * 1024);
		try {
			const zeros = Buffer.alloc(2 * 1024 * 1024); // decompressed 2 MiB
			const gz = Bun.gzipSync(zeros);
			const res = await postIngest(token, "irjg", key, gz, {
				activityId: key,
			});
			expect(res.status).toBe(413);
			expect(((await res.json()) as { error: string }).error).toBe(
				"payload_too_large",
			);
		} finally {
			delete process.env.AL_PERF_MAX_PROFILE_BYTES;
		}
	});
});
