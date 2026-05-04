import { timingSafeEqual } from "crypto";

const BEARER = "Bearer ";

export function checkBearerToken(headerValue: string | null | undefined, expected: string): boolean {
	if (typeof headerValue !== "string") return false;
	if (!headerValue.startsWith(BEARER)) return false;
	const provided = headerValue.slice(BEARER.length);
	const a = Buffer.from(provided, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export function loadPocSecret(): string {
	const s = process.env.AL_PERF_POC_SECRET;
	if (!s || s.length < 8) {
		throw new Error("AL_PERF_POC_SECRET env var must be set (>=8 chars) for POC ingest");
	}
	return s;
}
