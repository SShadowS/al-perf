import { describe, expect, it } from "bun:test";
import { createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, constants as cryptoConst } from "crypto";
import { decryptBundleForTest, encryptBundle, xmlRsaToJwk } from "../../web/crypto.ts";

function generateRsaKeypairXml(): { publicXml: string; privatePem: string } {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const jwk = publicKey.export({ format: "jwk" });
	// Convert public JWK back to XML form for the test (mirrors what AL produces)
	const modulus = jwk.n!;
	const exponent = jwk.e!;
	const xml = `<RSAKeyValue><Modulus>${modulus}</Modulus><Exponent>${exponent}</Exponent></RSAKeyValue>`;
	return { publicXml: xml, privatePem: privateKey.export({ format: "pem", type: "pkcs8" }) as string };
}

describe("xmlRsaToJwk", () => {
	it("parses .NET RSA XML to JWK", () => {
		const xml = "<RSAKeyValue><Modulus>nyU=</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>";
		const jwk = xmlRsaToJwk(xml);
		expect(jwk.kty).toBe("RSA");
		// Base64 → Base64URL conversion: nyU= → nyU
		expect(jwk.n).toBe("nyU");
		expect(jwk.e).toBe("AQAB");
	});

	it("preserves long modulus base64url-safely", () => {
		const xml = "<RSAKeyValue><Modulus>abc/def+ghi=</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>";
		const jwk = xmlRsaToJwk(xml);
		expect(jwk.n).toBe("abc_def-ghi");
	});

	it("throws on malformed XML", () => {
		expect(() => xmlRsaToJwk("not xml")).toThrow();
		expect(() => xmlRsaToJwk("<RSAKeyValue/>")).toThrow();
	});
});

describe("encryptBundle round-trip (RSA-OAEP-SHA1 + AES-256-CBC + HMAC-SHA256)", () => {
	it("encrypts and the test-only decrypter recovers original", () => {
		const { publicXml, privatePem } = generateRsaKeypairXml();
		const jwk = xmlRsaToJwk(publicXml);

		const plaintextBlob = Buffer.from("hello world ".repeat(100), "utf8");
		const plaintextResult = Buffer.from(JSON.stringify({ ok: true, n: 42 }), "utf8");
		const manifestBytes = Buffer.from(JSON.stringify({ activityId: "test" }), "utf8");

		const bundle = encryptBundle(plaintextBlob, plaintextResult, manifestBytes, jwk);

		// Sanity layout
		expect(bundle.wrapped.byteLength).toBe(384); // RSA-3072 ciphertext
		expect(bundle.blob.iv.byteLength).toBe(16);
		expect(bundle.blob.tag.byteLength).toBe(32);
		expect(bundle.result.iv.byteLength).toBe(16);
		expect(bundle.result.tag.byteLength).toBe(32);

		// Decrypt with the matching private key
		const recovered = decryptBundleForTest(bundle, manifestBytes, privatePem);
		expect(recovered.blob.equals(plaintextBlob)).toBe(true);
		expect(recovered.result.equals(plaintextResult)).toBe(true);
	});

	it("rejects tampered ciphertext via HMAC mismatch", () => {
		const { publicXml, privatePem } = generateRsaKeypairXml();
		const jwk = xmlRsaToJwk(publicXml);

		const blob = Buffer.from("hello", "utf8");
		const result = Buffer.from("{}", "utf8");
		const manifest = Buffer.from('{"x":1}', "utf8");

		const bundle = encryptBundle(blob, result, manifest, jwk);
		// Flip a byte in blob ciphertext
		bundle.blob.ciphertext[0] ^= 0x01;

		expect(() => decryptBundleForTest(bundle, manifest, privatePem)).toThrow(/tag/i);
	});

	it("rejects swapped manifest via HMAC mismatch", () => {
		const { publicXml, privatePem } = generateRsaKeypairXml();
		const jwk = xmlRsaToJwk(publicXml);

		const blob = Buffer.from("hello", "utf8");
		const result = Buffer.from("{}", "utf8");
		const manifest = Buffer.from('{"x":1}', "utf8");
		const otherManifest = Buffer.from('{"x":2}', "utf8");

		const bundle = encryptBundle(blob, result, manifest, jwk);

		expect(() => decryptBundleForTest(bundle, otherManifest, privatePem)).toThrow(/tag/i);
	});
});
