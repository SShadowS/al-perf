import { createHash, randomBytes, timingSafeEqual } from "crypto";

const BEARER = "Bearer ";

export function extractBearerToken(
	headerValue: string | null | undefined,
): string | null {
	if (typeof headerValue !== "string") return null;
	if (!headerValue.startsWith(BEARER)) return null;
	return headerValue.slice(BEARER.length);
}

/**
 * Constant-time string comparison. Both sides are hashed first so neither
 * length nor content leaks through timing.
 */
export function secureEquals(a: string, b: string): boolean {
	const ha = createHash("sha256").update(a, "utf8").digest();
	const hb = createHash("sha256").update(b, "utf8").digest();
	return timingSafeEqual(ha, hb);
}

export function checkBearerToken(
	headerValue: string | null | undefined,
	expected: string,
): boolean {
	const provided = extractBearerToken(headerValue);
	if (provided === null) return false;
	return secureEquals(provided, expected);
}

/** 256-bit per-tenant token, issued once at registration. */
export function generateTenantToken(): string {
	return randomBytes(32).toString("base64url");
}

/** Only the hash is stored server-side; the token itself is never persisted. */
export function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Check a bearer header against a stored sha256 token hash (hex). */
export function checkBearerAgainstHash(
	headerValue: string | null | undefined,
	tokenHashHex: string,
): boolean {
	const provided = extractBearerToken(headerValue);
	if (provided === null) return false;
	const providedHash = createHash("sha256").update(provided, "utf8").digest();
	const stored = Buffer.from(tokenHashHex, "hex");
	if (stored.length !== providedHash.length) return false;
	return timingSafeEqual(providedHash, stored);
}

export function loadPocSecret(): string {
	const s = process.env.AL_PERF_POC_SECRET;
	if (!s || s.length < 8) {
		throw new Error(
			"AL_PERF_POC_SECRET env var must be set (>=8 chars) for POC ingest",
		);
	}
	return s;
}

/**
 * Admin secret gates tenant registration and ops endpoints. Separate from the
 * per-tenant ingest tokens; falls back to the POC secret when not set.
 */
export function loadAdminSecret(): string {
	const s = process.env.AL_PERF_ADMIN_SECRET;
	if (s && s.length >= 8) return s;
	return loadPocSecret();
}

/**
 * Legacy shared-secret ingest auth (bearer == POC secret + x-tenant-id header).
 * Off by default — the shared secret cannot bind tenant to credential, so any
 * holder could write to any tenant. Explicit opt-in for old clients only.
 */
export function sharedSecretAllowed(): boolean {
	return process.env.AL_PERF_ALLOW_SHARED_SECRET === "1";
}
