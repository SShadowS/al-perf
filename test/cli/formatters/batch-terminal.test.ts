import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { analyzeBatch } from "../../../src/core/batch-analyzer.js";
import { formatBatch } from "../../../src/cli/formatters/index.js";
import { formatBatchTerminal } from "../../../src/cli/formatters/batch-terminal.js";

const BATCH_DIR = resolve(import.meta.dir, "../../fixtures/batch");

describe("formatBatch terminal", () => {
  test("produces terminal output with all sections", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const output = formatBatch(result, "terminal");

    expect(output).toContain("Batch Analysis");
    expect(output).toContain("profiles");
    expect(output).toContain("Health");
  });

  test("includes batch summary section", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const output = formatBatchTerminal(result);

    expect(output).toContain("Batch Summary");
    expect(output).toContain("Profiles: 2");
    expect(output).toContain("/100");
  });

  test("includes activity breakdown section", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const output = formatBatchTerminal(result);

    expect(output).toContain("Activity Breakdown");
  });

  test("includes cumulative hotspots section", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const output = formatBatchTerminal(result);

    expect(output).toContain("Cumulative Hotspots");
  });

  test("includes app breakdown section", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const output = formatBatchTerminal(result);

    expect(output).toContain("App Breakdown");
  });

  test("includes explanation section when present", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);
    result.explanation = "This batch shows recurring performance issues.";

    const output = formatBatchTerminal(result);

    expect(output).toContain("AI Analysis");
    expect(output).toContain("This batch shows recurring performance issues.");
  });

  test("omits explanation section when not present", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const output = formatBatchTerminal(result);

    expect(output).not.toContain("AI Analysis");
  });

  test("uses metadata descriptions when available", async () => {
    const metadata = [
      {
        activityId: "a1",
        activityType: "WebClient" as const,
        activityDescription: "Sales Order List",
        startTime: "2026-03-01T08:00:00Z",
        activityDuration: 5000,
        alExecutionDuration: 3200,
        sqlCallDuration: 1200,
        sqlCallCount: 45,
        httpCallDuration: 0,
        httpCallCount: 0,
        userName: "admin",
        clientSessionId: 101,
      },
      {
        activityId: "a2",
        activityType: "Background" as const,
        activityDescription: "Job Queue: Calc Inventory",
        startTime: "2026-03-01T09:00:00Z",
        activityDuration: 8000,
        alExecutionDuration: 6100,
        sqlCallDuration: 3400,
        sqlCallCount: 120,
        httpCallDuration: 200,
        httpCallCount: 2,
        userName: "admin",
        clientSessionId: 102,
      },
    ];

    const result = await analyzeBatch(
      [
        resolve(BATCH_DIR, "profile-1.alcpuprofile"),
        resolve(BATCH_DIR, "profile-2.alcpuprofile"),
      ],
      { metadata },
    );

    const output = formatBatchTerminal(result);

    expect(output).toContain("Sales Order List");
    expect(output).toContain("Job Queue: Calc Inventory");
  });

  test("formatBatch with json format returns valid JSON", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const output = formatBatch(result, "json");
    const parsed = JSON.parse(output);

    expect(parsed.meta.profileCount).toBe(2);
    expect(parsed.summary).toBeDefined();
  });
});
