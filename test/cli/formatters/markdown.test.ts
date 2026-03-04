import { describe, test, expect } from "bun:test";
import { analyzeProfile, compareProfiles } from "../../../src/core/analyzer.js";
import { formatAnalysisMarkdown, formatComparisonMarkdown } from "../../../src/cli/formatters/markdown.js";

const FIXTURES = "test/fixtures";

describe("formatAnalysisMarkdown", () => {
  test("includes markdown header", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisMarkdown(result);
    expect(output).toContain("# AL Profile Analysis");
  });

  test("includes summary section", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisMarkdown(result);
    expect(output).toContain("## Summary");
    expect(output).toContain("sampling");
  });

  test("includes hotspots as markdown table", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisMarkdown(result);
    expect(output).toContain("## Top Hotspots");
    expect(output).toContain("| # |");
    expect(output).toContain("ProcessLine");
  });

  test("includes detected patterns with severity badges", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisMarkdown(result);
    expect(output).toContain("## Detected Patterns");
    expect(output).toMatch(/\*\*(CRITICAL|WARNING|INFO)\*\*/);
  });

  test("includes app breakdown", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisMarkdown(result);
    expect(output).toContain("## App Breakdown");
    expect(output).toContain("My Extension");
  });

  test("includes suggestion when pattern has one", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisMarkdown(result);
    if (result.patterns.some(p => p.suggestion)) {
      expect(output).toContain("**Suggestion:**");
    }
  });

  test("includes explanation section when present", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    result.explanation = "This profile shows significant time in ProcessLine.";
    const output = formatAnalysisMarkdown(result);
    expect(output).toContain("## AI Analysis");
    expect(output).toContain("This profile shows significant time in ProcessLine.");
  });

  test("omits explanation section when not present", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisMarkdown(result);
    expect(output).not.toContain("## AI Analysis");
  });
});

describe("formatComparisonMarkdown", () => {
  test("includes comparison header", async () => {
    const result = await compareProfiles(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
    );
    const output = formatComparisonMarkdown(result);
    expect(output).toContain("# AL Profile Comparison");
  });

  test("includes before/after paths", async () => {
    const result = await compareProfiles(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
    );
    const output = formatComparisonMarkdown(result);
    expect(output).toContain("**Before:**");
    expect(output).toContain("**After:**");
  });

  test("includes delta summary with direction", async () => {
    const result = await compareProfiles(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
    );
    const output = formatComparisonMarkdown(result);
    expect(output).toContain("## Delta Summary");
    expect(output).toMatch(/SLOWER|FASTER|UNCHANGED/);
  });

  test("includes regressions table if present", async () => {
    const result = await compareProfiles(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
    );
    const output = formatComparisonMarkdown(result);
    if (result.regressions.length > 0) {
      expect(output).toContain("## Regressions");
      expect(output).toContain("| Function |");
    }
  });
});
