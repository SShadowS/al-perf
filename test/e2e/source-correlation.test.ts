import { describe, test, expect } from "bun:test";
import { resolve } from "path";

const cliPath = resolve(import.meta.dir, "../../src/cli/index.ts");
const fixturesDir = resolve(import.meta.dir, "../fixtures");
const fixturesSourceDir = resolve(import.meta.dir, "../fixtures/source");
describe("E2E: source correlation", () => {
  test("analyze with --source includes sourceAvailable=true", async () => {
    const profile = resolve(fixturesDir, "sampling-minimal.alcpuprofile");
    const proc = Bun.spawn([
      "bun", "run", cliPath, "analyze", profile,
      "-s", fixturesSourceDir,
      "-f", "json",
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    const result = JSON.parse(output);
    expect(result.meta.sourceAvailable).toBe(true);
  });

  test("analyze without --source has sourceAvailable=false for sampling profile", async () => {
    const profile = resolve(fixturesDir, "sampling-minimal.alcpuprofile");
    const proc = Bun.spawn([
      "bun", "run", cliPath, "analyze", profile, "-f", "json",
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    const result = JSON.parse(output);
    expect(result.meta.sourceAvailable).toBe(false);
  });

  test("source-map outputs correct JSON for fixture source", async () => {
    const proc = Bun.spawn([
      "bun", "run", cliPath, "source-map", fixturesSourceDir, "-f", "json",
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    const result = JSON.parse(output);
    expect(result.files.length).toBe(11);
    expect(result.procedureCount).toBeGreaterThan(0);
    expect(result.triggerCount).toBeGreaterThan(0);
  });

  test("source-map terminal output contains expected headings", async () => {
    const proc = Bun.spawn([
      "bun", "run", cliPath, "source-map", fixturesSourceDir, "-f", "terminal",
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    expect(output).toContain("Source Index");
    expect(output).toContain("Files:");
    expect(output).toContain("Procedures:");
  });

  test("explain outputs method details as JSON", async () => {
    const profile = resolve(fixturesDir, "sampling-minimal.alcpuprofile");
    const proc = Bun.spawn([
      "bun", "run", cliPath, "explain", profile, "OnRun", "-f", "json",
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    const result = JSON.parse(output);
    expect(result.method.functionName).toBe("OnRun");
    expect(result.profileStats.hitCount).toBeGreaterThan(0);
  });

  test("analyze instrumentation profile without companion zip has sourceAvailable=false", async () => {
    const profile = resolve(fixturesDir, "instrumentation-minimal.alcpuprofile");
    const proc = Bun.spawn([
      "bun", "run", cliPath, "analyze", profile, "-f", "json",
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    const result = JSON.parse(output);
    expect(result.meta.sourceAvailable).toBe(false);
    expect(result.meta.profileType).toBe("instrumentation");
  });
});
