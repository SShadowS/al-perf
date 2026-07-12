/**
 * tenant.test.ts — normalizeTenantCode (debt-closure plan D1): the
 * lifecycle-layer tenant-code normalizer that prevents `--tenant Pilot2`
 * and `--tenant pilot2` from becoming two case-distinct SQLite tenants.
 */

import { describe, expect, it } from "bun:test";
import { normalizeTenantCode } from "../../src/lifecycle/tenant.js";

describe("normalizeTenantCode", () => {
	it("lowercases", () => {
		expect(normalizeTenantCode("Pilot2")).toBe("pilot2");
	});

	it("trims surrounding whitespace", () => {
		expect(normalizeTenantCode("  acme  ")).toBe("acme");
	});

	it("is a byte-unchanged no-op on an already-lowercase, trimmed value", () => {
		expect(normalizeTenantCode("local")).toBe("local");
		expect(normalizeTenantCode("acme")).toBe("acme");
	});

	it("rejects empty-after-trim", () => {
		expect(() => normalizeTenantCode("")).toThrow();
		expect(() => normalizeTenantCode("   ")).toThrow();
	});
});
