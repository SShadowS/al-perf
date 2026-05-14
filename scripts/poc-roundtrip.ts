// scripts/poc-roundtrip.ts — POC v1 cross-language round-trip verifier (Node side)
// Confirms: register → encrypted ingest → fetch bundle → decrypt with private key.
import { generateKeyPairSync } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import { decryptBundleForTest } from "../web/crypto.ts";

const BASE = process.env.BASE ?? "http://localhost:3010";
const SECRET = process.env.AL_PERF_POC_SECRET ?? "test-secret-1234";

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
		tenantCode: "rt",
		sharedSecret: SECRET,
		publicKeyXml: publicXml,
	}),
});
console.log("register:", regRes.status);

const profileBytes = readFileSync(
	resolve("test/fixtures/instrumentation-minimal.alcpuprofile"),
);
const activityId = "550e8400-e29b-41d4-a716-446655440042";
const manifestBytes = Buffer.from(
	JSON.stringify({
		activityId,
		activityType: "Background",
		startTime: new Date().toISOString(),
	}),
	"utf8",
);

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

const ingestRes = await fetch(`${BASE}/api/ingest`, {
	method: "POST",
	headers: {
		Authorization: `Bearer ${SECRET}`,
		"X-Tenant-Id": "rt",
		"X-Idempotency-Key": activityId,
	},
	body: fd,
});
console.log("ingest:", ingestRes.status, await ingestRes.text());

const fetchRes = await fetch(`${BASE}/api/profiles/${activityId}?tenant=rt`, {
	headers: { Authorization: `Bearer ${SECRET}` },
});
const body = (await fetchRes.json()) as {
	keyVersion: number;
	manifest: string;
	wrapped: string;
	blob: { iv: string; tag: string; ciphertext: string };
	result: { iv: string; tag: string; ciphertext: string };
};
console.log("fetch:", fetchRes.status, "keyVersion=", body.keyVersion);

const wrapped = Buffer.from(body.wrapped, "base64");
const blob = {
	iv: Buffer.from(body.blob.iv, "base64"),
	tag: Buffer.from(body.blob.tag, "base64"),
	ciphertext: Buffer.from(body.blob.ciphertext, "base64"),
};
const result = {
	iv: Buffer.from(body.result.iv, "base64"),
	tag: Buffer.from(body.result.tag, "base64"),
	ciphertext: Buffer.from(body.result.ciphertext, "base64"),
};
const manifest = Buffer.from(body.manifest, "base64");

const recovered = decryptBundleForTest(
	{ wrapped, blob, result },
	manifest,
	privatePem,
);
console.log("blob match:", recovered.blob.equals(profileBytes));
console.log(
	"result first 80:",
	recovered.result.subarray(0, 80).toString("utf8"),
);

if (!recovered.blob.equals(profileBytes)) {
	console.error("FAIL: blob mismatch");
	process.exit(1);
}
console.log("PASS — round-trip verified");
