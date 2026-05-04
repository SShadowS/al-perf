import { describe, expect, it } from "bun:test";
import { checkBearerToken } from "../../web/poc-secret.ts";

describe("poc-secret", () => {
	it("accepts matching bearer token", () => {
		expect(checkBearerToken("Bearer secret123", "secret123")).toBe(true);
	});

	it("rejects mismatched token", () => {
		expect(checkBearerToken("Bearer wrong", "secret123")).toBe(false);
	});

	it("rejects header without Bearer prefix", () => {
		expect(checkBearerToken("secret123", "secret123")).toBe(false);
	});

	it("rejects null/undefined header", () => {
		expect(checkBearerToken(null, "secret123")).toBe(false);
		expect(checkBearerToken(undefined, "secret123")).toBe(false);
	});

	it("performs constant-time comparison (length mismatch is safe)", () => {
		expect(checkBearerToken("Bearer s", "secret123")).toBe(false);
	});
});
