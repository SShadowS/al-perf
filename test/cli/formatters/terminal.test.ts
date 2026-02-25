import { describe, test, expect } from "bun:test";
import { analyzeProfile, compareProfiles } from "../../../src/core/analyzer.js";
import { formatAnalysisTerminal, formatComparisonTerminal } from "../../../src/cli/formatters/terminal.js";

const FIXTURES = "test/fixtures";

describe("formatAnalysisTerminal", () => {
  test("includes profile summary", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisTerminal(result);
    expect(output).toContain("sampling");
    expect(output).toContain("3 nodes");
  });

  test("includes hotspots section", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisTerminal(result);
    expect(output).toContain("ProcessLine");
    expect(output).toContain("My Processor");
  });

  test("includes app breakdown", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisTerminal(result);
    expect(output).toContain("My Extension");
  });

  test("includes detected patterns", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisTerminal(result);
    expect(output).toContain("dominates");
  });
});

describe("formatComparisonTerminal", () => {
  test("includes delta summary", async () => {
    const result = await compareProfiles(
      "exampledata/PerformanceProfile_Session6.alcpuprofile",
      "exampledata/PerformanceProfile_Session15.alcpuprofile",
    );
    const output = formatComparisonTerminal(result);
    expect(output).toContain("Before");
    expect(output).toContain("After");
  });
});
