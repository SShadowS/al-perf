import { describe, test, expect } from "bun:test";
import { analyzeProfile } from "../../src/core/analyzer.js";
import type { ProcessedProfile } from "../../src/types/processed.js";

describe("analyzeProfile processedProfile callback", () => {
  test("calls onProcessedProfile with the processed profile", async () => {
    let captured: ProcessedProfile | undefined;

    await analyzeProfile("test/fixtures/sampling-minimal.alcpuprofile", {
      onProcessedProfile: (p) => { captured = p; },
    });

    expect(captured).toBeDefined();
    expect(captured!.roots.length).toBeGreaterThan(0);
    expect(captured!.allNodes.length).toBeGreaterThan(0);
  });

  test("does not error when callback is not provided", async () => {
    const result = await analyzeProfile("test/fixtures/sampling-minimal.alcpuprofile", {});
    expect(result).toBeDefined();
  });
});
