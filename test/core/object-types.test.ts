import { describe, test, expect } from "bun:test";
import { normalizeObjectType } from "../../src/core/object-types.js";

describe("normalizeObjectType", () => {
  test("maps known numeric types", () => {
    expect(normalizeObjectType(5)).toBe("CodeUnit");
    expect(normalizeObjectType(8)).toBe("Page");
    expect(normalizeObjectType(1)).toBe("Table");
    expect(normalizeObjectType(14)).toBe("PageExtension");
  });
  test("passes through string types unchanged", () => {
    expect(normalizeObjectType("CodeUnit")).toBe("CodeUnit");
    expect(normalizeObjectType("Page")).toBe("Page");
  });
  test("handles unknown numeric types", () => {
    expect(normalizeObjectType(99)).toBe("Unknown(99)");
  });
  test("handles undefined", () => {
    expect(normalizeObjectType(undefined)).toBe("");
  });
  test("handles system type (0)", () => {
    expect(normalizeObjectType(0)).toBe("System");
  });
});
