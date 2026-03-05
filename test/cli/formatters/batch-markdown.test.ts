import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { analyzeBatch } from "../../../src/core/batch-analyzer.js";
import { formatBatch } from "../../../src/cli/formatters/index.js";

const BATCH_DIR = resolve(import.meta.dir, "../../fixtures/batch");

describe("formatBatch markdown", () => {
  it("produces markdown output with all sections", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const output = formatBatch(result, "markdown");

    expect(output).toContain("# Batch Analysis");
    expect(output).toContain("## Recurring Patterns");
    expect(output).toContain("## Cumulative Hotspots");
    expect(output).toContain("## Activity Breakdown");
    expect(output).toContain("|");
  });
});
