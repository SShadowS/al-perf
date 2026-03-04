import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";
import { buildTableBreakdown } from "../../src/core/table-view.js";

const FIXTURES = resolve(import.meta.dir, "../fixtures");

describe("buildTableBreakdown", () => {
  test("returns empty array for profiles with no table operations", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const breakdown = buildTableBreakdown(processed);
    expect(Array.isArray(breakdown)).toBe(true);
    expect(breakdown.length).toBe(0);
  });

  test("aggregates table operations from instrumentation profile", async () => {
    const parsed = await parseProfile(`${FIXTURES}/instrumentation-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const breakdown = buildTableBreakdown(processed);
    expect(Array.isArray(breakdown)).toBe(true);
    // Results sorted by selfTime descending
    for (let i = 1; i < breakdown.length; i++) {
      expect(breakdown[i].totalSelfTime).toBeLessThanOrEqual(breakdown[i - 1].totalSelfTime);
    }
  });

  test("groups operations by table name from TableData nodes", async () => {
    const parsed = await parseProfile(`${FIXTURES}/table-operations.alcpuprofile`);
    const processed = processProfile(parsed);
    const breakdown = buildTableBreakdown(processed);

    // Should have two tables: Sales Line and Sales Header
    expect(breakdown.length).toBe(2);

    const salesLine = breakdown.find(t => t.tableName === "Sales Line");
    const salesHeader = breakdown.find(t => t.tableName === "Sales Header");
    expect(salesLine).toBeDefined();
    expect(salesHeader).toBeDefined();

    // Sales Line has Modify (300000) + FindSet (100000) + Insert (50000) = 450000
    expect(salesLine!.totalSelfTime).toBe(450000);

    // Sales Header has FindSet (200000) + CalcFields (150000) = 350000
    expect(salesHeader!.totalSelfTime).toBe(350000);
  });

  test("sorted by totalSelfTime descending", async () => {
    const parsed = await parseProfile(`${FIXTURES}/table-operations.alcpuprofile`);
    const processed = processProfile(parsed);
    const breakdown = buildTableBreakdown(processed);

    // Sales Line (450000) should be first, then Sales Header (350000)
    expect(breakdown[0].tableName).toBe("Sales Line");
    expect(breakdown[1].tableName).toBe("Sales Header");
  });

  test("computes operation breakdown per table", async () => {
    const parsed = await parseProfile(`${FIXTURES}/table-operations.alcpuprofile`);
    const processed = processProfile(parsed);
    const breakdown = buildTableBreakdown(processed);

    const salesLine = breakdown.find(t => t.tableName === "Sales Line")!;
    expect(salesLine.operationBreakdown.length).toBe(3);

    // Operations sorted by selfTime descending
    expect(salesLine.operationBreakdown[0].operation).toBe("Modify");
    expect(salesLine.operationBreakdown[0].selfTime).toBe(300000);
    expect(salesLine.operationBreakdown[0].hitCount).toBe(10);

    expect(salesLine.operationBreakdown[1].operation).toBe("FindSet");
    expect(salesLine.operationBreakdown[1].selfTime).toBe(100000);
    expect(salesLine.operationBreakdown[1].hitCount).toBe(3);

    expect(salesLine.operationBreakdown[2].operation).toBe("Insert");
    expect(salesLine.operationBreakdown[2].selfTime).toBe(50000);
    expect(salesLine.operationBreakdown[2].hitCount).toBe(2);
  });

  test("counts distinct call sites", async () => {
    const parsed = await parseProfile(`${FIXTURES}/table-operations.alcpuprofile`);
    const processed = processProfile(parsed);
    const breakdown = buildTableBreakdown(processed);

    // Sales Header has nodes 2 and 4 — node 2's parent is OnRun:50000, node 4's parent is ProcessLines:50000
    const salesHeader = breakdown.find(t => t.tableName === "Sales Header")!;
    expect(salesHeader.callSiteCount).toBe(2);

    // Sales Line has nodes 3, 6, 7 — all parents are ProcessLines:50000
    const salesLine = breakdown.find(t => t.tableName === "Sales Line")!;
    expect(salesLine.callSiteCount).toBe(1);
  });

  test("computes totalSelfTimePercent relative to activeSelfTime", async () => {
    const parsed = await parseProfile(`${FIXTURES}/table-operations.alcpuprofile`);
    const processed = processProfile(parsed);
    const breakdown = buildTableBreakdown(processed);

    // activeSelfTime = sum of all selfTimes (no idle nodes):
    //   50000 + 200000 + 30000 + 300000 + 150000 + 100000 + 50000 = 880000
    // Sales Line: 450000 / 880000 * 100 ~ 51.14%
    const salesLine = breakdown.find(t => t.tableName === "Sales Line")!;
    expect(salesLine.totalSelfTimePercent).toBeCloseTo(51.14, 0);

    // Sales Header: 350000 / 880000 * 100 ~ 39.77%
    const salesHeader = breakdown.find(t => t.tableName === "Sales Header")!;
    expect(salesHeader.totalSelfTimePercent).toBeCloseTo(39.77, 0);
  });

  test("defaults source flags to false without source index", async () => {
    const parsed = await parseProfile(`${FIXTURES}/table-operations.alcpuprofile`);
    const processed = processProfile(parsed);
    const breakdown = buildTableBreakdown(processed);

    for (const entry of breakdown) {
      expect(entry.hasSetLoadFields).toBe(false);
      expect(entry.hasFilters).toBe(false);
    }
  });
});
