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

  test("returns markdown when given markdown", () => {
    expect(resolveFormat("markdown")).toBe("markdown");
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

  test("formats as markdown when markdown is specified", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysis(result, "markdown");
    expect(output).toContain("# AL Profile Analysis");
    expect(output).toContain("## Top Hotspots");
  });
});

describe("formatComparison", () => {
  test("formats as JSON when json is specified", async () => {
    const result = await compareProfiles(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
    );
    const output = formatComparison(result, "json");
    const parsed = JSON.parse(output);
    expect(parsed.meta.beforePath).toBeTruthy();
  });

  test("formats as terminal when terminal is specified", async () => {
    const result = await compareProfiles(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
    );
    const output = formatComparison(result, "terminal");
    expect(output).toContain("Before");
    expect(output).toContain("After");
  });

  test("formats as markdown when markdown is specified", async () => {
    const result = await compareProfiles(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
    );
    const output = formatComparison(result, "markdown");
    expect(output).toContain("# AL Profile Comparison");
  });
});
