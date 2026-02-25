import { describe, test, expect } from "bun:test";

const CLI = "src/cli/index.ts";

describe("CLI gate command", () => {
  test("passes when critical count within threshold", async () => {
    const proc = Bun.spawn(
      ["bun", "run", CLI, "gate", "test/fixtures/sampling-minimal.alcpuprofile",
       "--max-critical", "99", "-f", "json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const text = await new Response(proc.stdout).text();
    const result = JSON.parse(text);
    expect(result.verdict).toBeDefined();
    expect(result.counts).toBeDefined();
    expect(proc.exitCode).toBe(0);
  });

  test("fails when critical threshold exceeded", async () => {
    const proc = Bun.spawn(
      ["bun", "run", CLI, "gate", "test/fixtures/sampling-minimal.alcpuprofile",
       "--max-critical", "0", "-f", "json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const text = await new Response(proc.stdout).text();
    const result = JSON.parse(text);
    expect(result.verdict).toBe("fail");
    expect(proc.exitCode).toBe(1);
  });

  test("--help lists gate command", async () => {
    const proc = Bun.spawn(
      ["bun", "run", CLI, "--help"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    expect(text).toContain("gate");
  });
});
