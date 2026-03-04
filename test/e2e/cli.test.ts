import { describe, test, expect } from "bun:test";
import { $ } from "bun";

const CLI = "src/cli/index.ts";
const FIXTURES = "test/fixtures";

describe("CLI E2E", () => {
  test("analyze outputs valid JSON with --format json", async () => {
    const result = await $`bun run ${CLI} analyze ${FIXTURES}/sampling-minimal.alcpuprofile -f json`.text();
    const parsed = JSON.parse(result);
    expect(parsed.meta.profileType).toBe("sampling");
    expect(parsed.hotspots.length).toBeGreaterThan(0);
  });

  test("analyze works on instrumentation profile", async () => {
    const result = await $`bun run ${CLI} analyze ${FIXTURES}/instrumentation-minimal.alcpuprofile -f json -n 2`.text();
    const parsed = JSON.parse(result);
    expect(parsed.meta.profileType).toBe("instrumentation");
    expect(parsed.hotspots).toHaveLength(2);
  });

  test("hotspots returns limited results", async () => {
    const result = await $`bun run ${CLI} hotspots ${FIXTURES}/sampling-minimal.alcpuprofile -f json -n 2`.text();
    const parsed = JSON.parse(result);
    expect(parsed.hotspots.length).toBeLessThanOrEqual(2);
  });

  test("compare outputs valid JSON", async () => {
    const result = await $`bun run ${CLI} compare ${FIXTURES}/sampling-minimal.alcpuprofile ${FIXTURES}/sampling-minimal.alcpuprofile -f json`.text();
    const parsed = JSON.parse(result);
    expect(parsed.meta.beforePath).toContain("sampling-minimal");
    expect(parsed.meta.afterPath).toContain("sampling-minimal");
    expect(parsed.summary.deltaTime).toBeDefined();
  });

  test("--help works", async () => {
    const result = await $`bun run ${CLI} --help`.text();
    expect(result).toContain("analyze");
    expect(result).toContain("hotspots");
    expect(result).toContain("compare");
  });
});
