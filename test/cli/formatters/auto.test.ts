import { describe, test, expect } from "bun:test";
import { resolveFormat } from "../../../src/cli/formatters/auto.js";
import { formatAnalysis, formatComparison } from "../../../src/cli/formatters/index.js";
import { analyzeProfile, compareProfiles } from "../../../src/core/analyzer.js";

const FIXTURES = "test/fixtures";

describe("resolveFormat", () => {
  test("returns terminal when given terminal", () => {
    expect(resolveFormat("terminal")).toBe("terminal");
  });

  test("returns json when given json", () => {
    expect(resolveFormat("json")).toBe("json");
  });

  test("returns terminal or json for auto based on TTY", () => {
    const result = resolveFormat("auto");
    expect(["terminal", "json"]).toContain(result);
  });
});

describe("formatAnalysis", () => {
  test("formats as JSON when json is specified", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysis(result, "json");
    const parsed = JSON.parse(output);
    expect(parsed.meta.profileType).toBe("sampling");
  });

  test("formats as terminal when terminal is specified", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysis(result, "terminal");
    expect(output).toContain("sampling");
    expect(output).toContain("3 nodes");
  });
});

describe("formatComparison", () => {
  test("formats as JSON when json is specified", async () => {
    const result = await compareProfiles(
      "exampledata/PerformanceProfile_Session6.alcpuprofile",
      "exampledata/PerformanceProfile_Session15.alcpuprofile",
    );
    const output = formatComparison(result, "json");
    const parsed = JSON.parse(output);
    expect(parsed.meta.beforePath).toBeTruthy();
  });

  test("formats as terminal when terminal is specified", async () => {
    const result = await compareProfiles(
      "exampledata/PerformanceProfile_Session6.alcpuprofile",
      "exampledata/PerformanceProfile_Session15.alcpuprofile",
    );
    const output = formatComparison(result, "terminal");
    expect(output).toContain("Before");
    expect(output).toContain("After");
  });
});
