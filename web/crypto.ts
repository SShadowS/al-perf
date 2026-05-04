import {
	constants as cryptoConst,
	createCipheriv,
	createDecipheriv,
	createHmac,
	createHash,
	createPrivateKey,
	createPublicKey,
	publicEncrypt,
	privateDecrypt,
	randomBytes,
	timingSafeEqual,
} from "crypto";

export interface RsaJwk {
	kty: "RSA";
	n: string;
	e: string;
}

export interface BundlePart {
	iv: Buffer;
	tag: Buffer;
	ciphertext: Buffer;
}

export interface EncryptedBundle {
	wrapped: Buffer;       // 384 bytes for RSA-3072
	blob: BundlePart;
	result: BundlePart;
}

const TAG_BYTES = 32;
const IV_BYTES = 16;

function base64ToBase64Url(s: string): string {
	return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function xmlRsaToJwk(xml: string): RsaJwk {
	const modulusMatch = xml.match(/<Modulus>([^<]+)<\/Modulus>/);
	const exponentMatch = xml.match(/<Exponent>([^<]+)<\/Exponent>/);
	if (!modulusMatch || !exponentMatch) {
		throw new Error("invalid RSA XML: missing Modulus/Exponent");
	}
	return {
		kty: "RSA",
		n: base64ToBase64Url(modulusMatch[1].trim()),
		e: base64ToBase64Url(exponentMatch[1].trim()),
	};
}

export function encryptBundle(
	plaintextBlob: Buffer,
	plaintextResult: Buffer,
	manifestBytes: Buffer,
	jwk: RsaJwk,
): EncryptedBundle {
	const kEnc = randomBytes(32);
	const kMac = randomBytes(32);
	const iv1 = randomBytes(IV_BYTES);
	const iv2 = randomBytes(IV_BYTES);
	const manifestHash = createHash("sha256").update(manifestBytes).digest();

	const ciphertextBlob = aesCbc256Encrypt(kEnc, iv1, plaintextBlob);
	const ciphertextResult = aesCbc256Encrypt(kEnc, iv2, plaintextResult);

	const tagBlob = hmacSha256(kMac, Buffer.concat([iv1, manifestHash, ciphertextBlob]));
	const tagResult = hmacSha256(kMac, Buffer.concat([iv2, manifestHash, ciphertextResult]));

	const pubKey = createPublicKey({ key: jwk, format: "jwk" });
	const wrapped = publicEncrypt(
		{
			key: pubKey,
			padding: cryptoConst.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha1", // matches AL RSA.Encrypt(...,OaepPadding=true,...) default
		},
		Buffer.concat([kEnc, kMac]),
	);

	return {
		wrapped,
		blob: { iv: iv1, tag: tagBlob, ciphertext: ciphertextBlob },
		result: { iv: iv2, tag: tagResult, ciphertext: ciphertextResult },
	};
}

function aesCbc256Encrypt(key: Buffer, iv: Buffer, plaintext: Buffer): Buffer {
	const cipher = createCipheriv("aes-256-cbc", key, iv);
	return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesCbc256Decrypt(key: Buffer, iv: Buffer, ciphertext: Buffer): Buffer {
	const decipher = createDecipheriv("aes-256-cbc", key, iv);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function hmacSha256(key: Buffer, data: Buffer): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

/**
 * For tests + e2e verification only. Real BC-side decrypt happens in AL.
 * Throws on HMAC tag mismatch.
 */
export function decryptBundleForTest(
	bundle: EncryptedBundle,
	manifestBytes: Buffer,
	privatePem: string,
): { blob: Buffer; result: Buffer } {
	const privKey = createPrivateKey({ key: privatePem });
	const keys = privateDecrypt(
		{
			key: privKey,
			padding: cryptoConst.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha1",
		},
		bundle.wrapped,
	);
	if (keys.byteLength !== 64) {
		throw new Error("unwrapped key material has wrong length");
	}
	const kEnc = keys.subarray(0, 32);
	const kMac = keys.subarray(32, 64);

	const manifestHash = createHash("sha256").update(manifestBytes).digest();

	verifyTag(kMac, bundle.blob, manifestHash);
	verifyTag(kMac, bundle.result, manifestHash);

	return {
		blob: aesCbc256Decrypt(kEnc, bundle.blob.iv, bundle.blob.ciphertext),
		result: aesCbc256Decrypt(kEnc, bundle.result.iv, bundle.result.ciphertext),
	};
}

function verifyTag(kMac: Buffer, part: BundlePart, manifestHash: Buffer): void {
	const expected = hmacSha256(kMac, Buffer.concat([part.iv, manifestHash, part.ciphertext]));
	if (expected.byteLength !== part.tag.byteLength) {
		throw new Error("tag length mismatch");
	}
	if (!timingSafeEqual(expected, part.tag)) {
		throw new Error("HMAC tag mismatch — tampered or wrong key");
	}
}
