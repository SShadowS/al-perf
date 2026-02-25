import { describe, test, expect } from "bun:test";
import { analyzeProfile, compareProfiles } from "../../../src/core/analyzer.js";
import { formatAnalysisJson, formatComparisonJson } from "../../../src/cli/formatters/json.js";

const FIXTURES = "test/fixtures";

describe("formatAnalysisJson", () => {
  test("returns valid JSON string", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisJson(result);
    const parsed = JSON.parse(output);
    expect(parsed.meta.profileType).toBe("sampling");
    expect(parsed.hotspots).toBeArray();
    expect(parsed.patterns).toBeArray();
  });

  test("is pretty-printed with 2-space indent", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisJson(result);
    expect(output).toContain("\n  ");
  });
});

describe("formatComparisonJson", () => {
  test("returns valid JSON string", async () => {
    const result = await compareProfiles(
      "exampledata/PerformanceProfile_Session6.alcpuprofile",
      "exampledata/PerformanceProfile_Session15.alcpuprofile",
    );
    const output = formatComparisonJson(result);
    const parsed = JSON.parse(output);
    expect(parsed.meta.beforePath).toBeTruthy();
    expect(parsed.summary.deltaTime).toBeDefined();
  });
});
