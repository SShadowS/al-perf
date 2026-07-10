import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { decryptBundleForTest } from "../../web/crypto.ts";

const TEST_DATA = mkdtempSync(join(tmpdir(), "alperf-poc-ingest-v1-"));
process.env.AL_PERF_DATA_DIR = TEST_DATA;
process.env.AL_PERF_POC_SECRET = "test-secret-1234";
// PORT shared with prior poc-* tests (Bun module cache); see A3 test for rationale.
process.env.PORT ??= "3999";

const { server } = await import("../../web/server.ts");
const BASE = `http://localhost:${server.port}`;

afterAll(() => {
	rmSync(TEST_DATA, { recursive: true, force: true });
});

const VALID_GUID = "550e8400-e29b-41d4-a716-446655440099";

describe("POST /api/ingest (v1 encrypted)", () => {
	it("persists ciphertext at rest, recoverable via decryptBundleForTest", async () => {
		const { publicKey, privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 3072,
		});
		const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
		const publicXml = `<RSAKeyValue><Modulus>${Buffer.from(jwk.n, "base64url").toString("base64")}</Modulus><Exponent>${Buffer.from(jwk.e, "base64url").toString("base64")}</Exponent></RSAKeyValue>`;
		const privatePem = privateKey.export({
			format: "pem",
			type: "pkcs8",
		}) as string;

		const regRes = await fetch(`${BASE}/api/tenants/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				tenantCode: "poc",
				sharedSecret: "test-secret-1234",
				publicKeyXml: publicXml,
			}),
		});
		const { tenantToken } = (await regRes.json()) as { tenantToken: string };

		const profilePath = resolve(
			import.meta.dir,
			"../fixtures/instrumentation-minimal.alcpuprofile",
		);
		const profileBytes = Buffer.from(readFileSync(profilePath));
		const manifest = {
			activityId: VALID_GUID,
			activityType: "Background",
			startTime: new Date().toISOString(),
		};
		const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");

		const fd = new FormData();
		fd.append(
			"manifest",
			new Blob([manifestBytes], { type: "application/json" }),
			"manifest.json",
		);
		fd.append(
			"profile",
			new Blob([profileBytes], { type: "application/octet-stream" }),
			"p.alcpuprofile",
		);

		const res = await fetch(`${BASE}/api/ingest`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tenantToken}`,
				"X-Tenant-Id": "poc",
				"X-Idempotency-Key": VALID_GUID,
			},
			body: fd,
		});
		expect(res.status).toBe(202);

		const profileDir = join(
			TEST_DATA,
			"storage",
			"poc",
			"profiles",
			VALID_GUID,
		);
		// v1: ciphertext artifacts present, plaintext absent
		expect(existsSync(join(profileDir, "wrapped.bin"))).toBe(true);
		expect(existsSync(join(profileDir, "blob.enc"))).toBe(true);
		expect(existsSync(join(profileDir, "result.enc"))).toBe(true);
		expect(existsSync(join(profileDir, "keyversion.txt"))).toBe(true);
		expect(existsSync(join(profileDir, "manifest.json"))).toBe(true);
		expect(existsSync(join(profileDir, "metrics.json"))).toBe(true);
		expect(existsSync(join(profileDir, "profile.bin"))).toBe(false);
		expect(existsSync(join(profileDir, "result.json"))).toBe(false);

		// Verify ciphertext != plaintext
		const blobEnc = readFileSync(join(profileDir, "blob.enc"));
		expect(blobEnc.indexOf(profileBytes.subarray(0, 16))).toBe(-1);

		// Roundtrip via private key
		const wrapped = readFileSync(join(profileDir, "wrapped.bin"));
		const blob = readBundlePart(blobEnc);
		const resultEnc = readFileSync(join(profileDir, "result.enc"));
		const result = readBundlePart(resultEnc);
		const storedManifest = readFileSync(join(profileDir, "manifest.json"));

		const recovered = decryptBundleForTest(
			{ wrapped, blob, result },
			storedManifest,
			privatePem,
		);
		expect(recovered.blob.equals(profileBytes)).toBe(true);
	});
});

function readBundlePart(file: Buffer): {
	iv: Buffer;
	tag: Buffer;
	ciphertext: Buffer;
} {
	return {
		iv: file.subarray(0, 16),
		tag: file.subarray(16, 48),
		ciphertext: file.subarray(48),
	};
}
