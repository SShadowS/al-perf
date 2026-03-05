import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { analyzeBatch } from "../../src/core/batch-analyzer.js";
import type { ProfileMetadata } from "../../src/types/batch.js";

const BATCH_DIR = resolve(import.meta.dir, "../fixtures/batch");

describe("analyzeBatch", () => {
  it("analyzes multiple profiles and produces aggregate result", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    expect(result.meta.profileCount).toBe(2);
    expect(result.profiles).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.summary.oneLiner).toBeTruthy();
    expect(result.summary.overallHealthScore).toBeGreaterThanOrEqual(0);
    expect(result.summary.overallHealthScore).toBeLessThanOrEqual(100);
    expect(result.activityBreakdown).toHaveLength(2);
    expect(result.cumulativeHotspots.length).toBeGreaterThan(0);
    expect(result.appBreakdown.length).toBeGreaterThan(0);
  });

  it("includes metadata when manifest is provided", async () => {
    const manifest: ProfileMetadata[] = JSON.parse(
      await Bun.file(resolve(BATCH_DIR, "manifest.json")).text()
    );

    const result = await analyzeBatch(
      [
        resolve(BATCH_DIR, "profile-1.alcpuprofile"),
        resolve(BATCH_DIR, "profile-2.alcpuprofile"),
      ],
      { metadata: manifest }
    );

    expect(result.activityBreakdown[0].metadata).toBeDefined();
    expect(result.meta.activityTypes["WebClient"]).toBe(1);
    expect(result.meta.activityTypes["Background"]).toBe(1);
    expect(result.meta.timeRange).not.toBeNull();
  });

  it("handles partial failures gracefully", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "nonexistent.alcpuprofile"),
    ]);

    expect(result.meta.profileCount).toBe(1);
    expect(result.profiles).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].profilePath).toContain("nonexistent");
  });

  it("fails entirely when zero profiles succeed", async () => {
    await expect(
      analyzeBatch([resolve(BATCH_DIR, "nonexistent.alcpuprofile")])
    ).rejects.toThrow();
  });

  it("handles single-profile batch", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
    ]);

    expect(result.meta.profileCount).toBe(1);
    expect(result.profiles).toHaveLength(1);
    expect(result.cumulativeHotspots.length).toBeGreaterThan(0);
  });
});
