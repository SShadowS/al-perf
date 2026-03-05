import { describe, it, expect } from "bun:test";
import { resolve } from "path";
import { analyzeBatch } from "../../../src/core/batch-analyzer.js";
import { formatBatchHtml } from "../../../src/cli/formatters/batch-html.js";

const BATCH_DIR = resolve(import.meta.dir, "../../fixtures/batch");

describe("formatBatchHtml", () => {
  it("produces a self-contained HTML page", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const html = formatBatchHtml(result);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Batch Analysis");
    expect(html).toContain("Recurring Patterns");
    expect(html).toContain("Cumulative Hotspots");
    expect(html).toContain("Activity Breakdown");
    expect(html).toContain("<style>");
  });

  it("includes health score badge", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const html = formatBatchHtml(result);

    expect(html).toContain("/100 Health");
  });

  it("includes pattern count badges", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const html = formatBatchHtml(result);

    expect(html).toContain("Critical");
    expect(html).toContain("Warning");
    expect(html).toContain("Info");
  });

  it("includes app breakdown section", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const html = formatBatchHtml(result);

    expect(html).toContain("App Breakdown");
  });

  it("includes explanation section when present", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);
    result.explanation = "This batch shows recurring performance issues.";

    const html = formatBatchHtml(result);

    expect(html).toContain("AI Analysis");
    expect(html).toContain("This batch shows recurring performance issues.");
  });

  it("omits explanation section when not present", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const html = formatBatchHtml(result);

    expect(html).not.toContain("AI Analysis");
  });

  it("uses metadata descriptions when available", async () => {
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

    const html = formatBatchHtml(result);

    expect(html).toContain("Sales Order List");
    expect(html).toContain("Job Queue: Calc Inventory");
  });

  it("uses details/summary for activity drill-down", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const html = formatBatchHtml(result);

    expect(html).toContain("<details>");
    expect(html).toContain("<summary");
    expect(html).toContain("</details>");
  });

  it("has inline CSS with no external dependencies", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const html = formatBatchHtml(result);

    // Has inline styles
    expect(html).toContain("<style>");
    expect(html).toContain("</style>");
    // No external stylesheet links or script tags
    expect(html).not.toContain("<link rel=\"stylesheet\"");
    expect(html).not.toContain("<script src=");
  });

  it("shows profile count in the title", async () => {
    const result = await analyzeBatch([
      resolve(BATCH_DIR, "profile-1.alcpuprofile"),
      resolve(BATCH_DIR, "profile-2.alcpuprofile"),
    ]);

    const html = formatBatchHtml(result);

    expect(html).toContain("2 profiles");
  });
});
