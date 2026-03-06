import { describe, test, expect } from "bun:test";
import { analyzeProfile } from "../../src/core/analyzer.js";

describe("source snippet population", () => {
  test("hotspots have sourceSnippet when source is available", async () => {
    const result = await analyzeProfile("test/fixtures/sampling-minimal.alcpuprofile", {
      sourcePath: "test/fixtures/source",
      top: 5,
    });

    const withSource = result.hotspots.filter((h) => h.sourceLocation);
    if (withSource.length > 0) {
      const hotspot = withSource[0];
      expect(hotspot.sourceSnippet).toBeDefined();
      expect(typeof hotspot.sourceSnippet).toBe("string");
      expect(hotspot.sourceSnippet!.length).toBeGreaterThan(0);
    }
  });

  test("hotspots without source have no sourceSnippet", async () => {
    const result = await analyzeProfile("test/fixtures/sampling-minimal.alcpuprofile", {
      top: 5,
    });

    for (const h of result.hotspots) {
      expect(h.sourceSnippet).toBeUndefined();
    }
  });
});
