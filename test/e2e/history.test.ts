import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { existsSync, rmSync } from "fs";

const cliPath = resolve(import.meta.dir, "../../src/cli/index.ts");
const fixturesDir = resolve(import.meta.dir, "../fixtures");
const historyDir = resolve(import.meta.dir, "../fixtures/.history-e2e-test");

describe("E2E: history", () => {
  beforeEach(() => {
    if (existsSync(historyDir)) rmSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(historyDir)) rmSync(historyDir, { recursive: true });
  });

  test("analyze --save-history stores entry", async () => {
    const profile = resolve(fixturesDir, "sampling-minimal.alcpuprofile");
    const proc = Bun.spawn([
      "bun", "run", cliPath, "analyze", profile,
      "-f", "json",
      "--save-history",
      "--history-dir", historyDir,
      "--label", "test-run",
    ]);
    await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    // Verify history entry was created
    expect(existsSync(historyDir)).toBe(true);

    // List entries
    const listProc = Bun.spawn([
      "bun", "run", cliPath, "history", "list",
      "--history-dir", historyDir,
    ]);
    const listOutput = await new Response(listProc.stdout).text();
    await listProc.exited;
    expect(listProc.exitCode).toBe(0);
    expect(listOutput).toContain("test-run");
  });

  test("history list shows no entries message for empty store", async () => {
    const listProc = Bun.spawn([
      "bun", "run", cliPath, "history", "list",
      "--history-dir", historyDir,
    ]);
    const listOutput = await new Response(listProc.stdout).text();
    await listProc.exited;
    expect(listProc.exitCode).toBe(0);
    expect(listOutput).toContain("No history entries found.");
  });

  test("history trend requires at least 2 entries", async () => {
    const profile = resolve(fixturesDir, "sampling-minimal.alcpuprofile");

    // Save one entry
    const proc = Bun.spawn([
      "bun", "run", cliPath, "analyze", profile,
      "-f", "json",
      "--save-history",
      "--history-dir", historyDir,
    ]);
    await new Response(proc.stdout).text();
    await proc.exited;

    // Trend with only 1 entry
    const trendProc = Bun.spawn([
      "bun", "run", cliPath, "history", "trend",
      "--history-dir", historyDir,
    ]);
    const trendOutput = await new Response(trendProc.stdout).text();
    await trendProc.exited;
    expect(trendProc.exitCode).toBe(0);
    expect(trendOutput).toContain("Need at least 2 history entries");
  });

  test("history clear removes all entries", async () => {
    const profile = resolve(fixturesDir, "sampling-minimal.alcpuprofile");
    // Save two entries
    for (let i = 0; i < 2; i++) {
      const proc = Bun.spawn([
        "bun", "run", cliPath, "analyze", profile,
        "-f", "json",
        "--save-history",
        "--history-dir", historyDir,
      ]);
      await new Response(proc.stdout).text();
      await proc.exited;
    }

    // Clear
    const clearProc = Bun.spawn([
      "bun", "run", cliPath, "history", "clear",
      "--history-dir", historyDir,
    ]);
    const clearOutput = await new Response(clearProc.stdout).text();
    await clearProc.exited;
    expect(clearProc.exitCode).toBe(0);
    expect(clearOutput).toContain("Cleared 2");
  });
});
