import { describe, test, expect } from "bun:test";

const CLI = "src/cli/index.ts";

describe("CLI analyze-source command", () => {
  test("analyzes source directory and returns JSON", async () => {
    const proc = Bun.spawn(
      ["bun", "run", CLI, "analyze-source", "test/fixtures/source", "-f", "json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const text = await new Response(proc.stdout).text();
    const result = JSON.parse(text);
    expect(proc.exitCode).toBe(0);
    expect(result.files).toBeGreaterThan(0);
    expect(result.objects).toBeDefined();
    expect(result.findings).toBeDefined();
    expect(result.findings.length).toBeGreaterThan(0);
  });

  test("includes nested loop findings", async () => {
    const proc = Bun.spawn(
      ["bun", "run", CLI, "analyze-source", "test/fixtures/source", "-f", "json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const text = await new Response(proc.stdout).text();
    const result = JSON.parse(text);

    const nestedLoop = result.findings.find(
      (f: any) => f.id === "nested-loops",
    );
    expect(nestedLoop).toBeDefined();
  });

  test("includes table clusters when present", async () => {
    const proc = Bun.spawn(
      ["bun", "run", CLI, "analyze-source", "test/fixtures/source", "-f", "json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const text = await new Response(proc.stdout).text();
    const result = JSON.parse(text);

    expect(result.tableClusters).toBeDefined();
    expect(Array.isArray(result.tableClusters)).toBe(true);
  });

  test("--help lists analyze-source command", async () => {
    const proc = Bun.spawn(
      ["bun", "run", CLI, "--help"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    expect(text).toContain("analyze-source");
  });
});
