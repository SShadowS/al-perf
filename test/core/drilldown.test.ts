import { describe, test, expect } from "bun:test";
import { drilldownMethod } from "../../src/core/drilldown.js";

const FIXTURES = "test/fixtures";

describe("drilldownMethod", () => {
  test("returns subtree breakdown for a method", async () => {
    const result = await drilldownMethod(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      "OnRun",
    );
    expect(result).toBeDefined();
    expect(result!.method.functionName).toBe("OnRun");
    expect(result!.breakdown.childContributions.length).toBeGreaterThan(0);
    // OnRun calls ProcessLine — ProcessLine should be in child contributions
    const processLine = result!.breakdown.childContributions.find(
      c => c.functionName === "ProcessLine",
    );
    expect(processLine).toBeDefined();
    expect(processLine!.contributionPercent).toBeGreaterThan(0);
    // Self + children should roughly equal totalTime
    const childTotal = result!.breakdown.childContributions.reduce(
      (sum, c) => sum + c.totalTime, 0,
    );
    expect(result!.breakdown.selfTimeInMethod + childTotal).toBeCloseTo(
      result!.method.totalTime, -2,
    );
  });

  test("returns null for non-existent method", async () => {
    const result = await drilldownMethod(
      `${FIXTURES}/sampling-minimal.alcpuprofile`,
      "NonExistentMethod",
    );
    expect(result).toBeNull();
  });
});
