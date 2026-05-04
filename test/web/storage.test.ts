import { describe, expect, it } from "bun:test";
import { resolve as resolvePath } from "path";
import { isValidActivityId, isValidTenantCode, resolveStoragePath } from "../../web/storage.ts";

describe("storage helpers", () => {
	describe("isValidActivityId", () => {
		it("accepts a v4 GUID", () => {
			expect(isValidActivityId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
		});

		it("accepts uppercase GUID and treats lowercase form as canonical", () => {
			expect(isValidActivityId("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
		});

		it("rejects path traversal attempts", () => {
			expect(isValidActivityId("../../etc/passwd")).toBe(false);
			expect(isValidActivityId("..")).toBe(false);
			expect(isValidActivityId("foo/bar")).toBe(false);
			expect(isValidActivityId("")).toBe(false);
		});

		it("rejects non-GUID strings", () => {
			expect(isValidActivityId("not-a-guid")).toBe(false);
			expect(isValidActivityId("550e8400-e29b-41d4-a716")).toBe(false);
		});
	});

	describe("isValidTenantCode", () => {
		it("accepts lowercase alphanumeric with dashes", () => {
			expect(isValidTenantCode("poc")).toBe(true);
			expect(isValidTenantCode("acme-prod")).toBe(true);
			expect(isValidTenantCode("a")).toBe(true);
		});

		it("rejects path traversal and uppercase", () => {
			expect(isValidTenantCode("../etc")).toBe(false);
			expect(isValidTenantCode("Acme")).toBe(false);
			expect(isValidTenantCode("acme/prod")).toBe(false);
			expect(isValidTenantCode("")).toBe(false);
		});

		it("enforces 40-char max", () => {
			expect(isValidTenantCode("a".repeat(40))).toBe(true);
			expect(isValidTenantCode("a".repeat(41))).toBe(false);
		});
	});

	describe("resolveStoragePath", () => {
		it("resolves under base directory", () => {
			const base = resolvePath("/tmp/al-perf");
			const result = resolveStoragePath(base, "poc", "profiles", "550e8400-e29b-41d4-a716-446655440000");
			expect(result.startsWith(base)).toBe(true);
		});

		it("throws on traversal attempt", () => {
			expect(() => resolveStoragePath("/tmp/al-perf", "..", "etc")).toThrow();
		});
	});
});
