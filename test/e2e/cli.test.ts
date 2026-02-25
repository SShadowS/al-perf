import { describe, test, expect } from "bun:test";
import { $ } from "bun";

const CLI = "src/cli/index.ts";

describe("CLI E2E", () => {
  test("analyze outputs valid JSON with --format json", async () => {
    const result = await $`bun run ${CLI} analyze exampledata/PerformanceProfile_Session6.alcpuprofile -f json`.text();
    const parsed = JSON.parse(result);
    expect(parsed.meta.profileType).toBe("sampling");
    expect(parsed.hotspots.length).toBeGreaterThan(0);
  });

  test("analyze works on instrumentation profile", async () => {
    const result = await $`bun run ${CLI} analyze exampledata/cedf4512-490d-4252-b9f6-943dd571888f.alcpuprofile -f json -n 3`.text();
    const parsed = JSON.parse(result);
    expect(parsed.meta.profileType).toBe("instrumentation");
    expect(parsed.hotspots).toHaveLength(3);
  }, 60000);

  test("hotspots returns limited results", async () => {
    const result = await $`bun run ${CLI} hotspots exampledata/PerformanceProfile_Session15.alcpuprofile -f json -n 2`.text();
    const parsed = JSON.parse(result);
    expect(parsed.hotspots.length).toBeLessThanOrEqual(2);
  });

  test("compare outputs valid JSON", async () => {
    const result = await $`bun run ${CLI} compare exampledata/PerformanceProfile_Session6.alcpuprofile exampledata/PerformanceProfile_Session15.alcpuprofile -f json`.text();
    const parsed = JSON.parse(result);
    expect(parsed.meta.beforePath).toContain("Session6");
    expect(parsed.meta.afterPath).toContain("Session15");
    expect(parsed.summary.deltaTime).toBeDefined();
  });

  test("--help works", async () => {
    const result = await $`bun run ${CLI} --help`.text();
    expect(result).toContain("analyze");
    expect(result).toContain("hotspots");
    expect(result).toContain("compare");
  });
});
