import { describe, it, expect } from "bun:test";
import { resolve } from "path";

const cliPath = resolve(import.meta.dir, "../../../src/cli/index.ts");
const fixturesDir = resolve(import.meta.dir, "../../fixtures");

describe("explain command", () => {
  it("should explain a method from a profile", async () => {
    const profile = resolve(fixturesDir, "sampling-minimal.alcpuprofile");
    const proc = Bun.spawn(["bun", "run", cliPath, "explain", profile, "OnRun", "-f", "json"]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const result = JSON.parse(output);
    expect(result.method).toBeDefined();
    expect(result.method.functionName).toBe("OnRun");
    expect(result.profileStats).toBeDefined();
  });

  it("should exit with error for unknown method", async () => {
    const profile = resolve(fixturesDir, "sampling-minimal.alcpuprofile");
    const proc = Bun.spawn(["bun", "run", cliPath, "explain", profile, "NonExistentMethod", "-f", "json"]);
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });
});
