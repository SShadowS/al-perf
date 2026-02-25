import { describe, test, expect } from "bun:test";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";

const FIXTURES = "test/fixtures";

describe("processProfile", () => {
  test("builds tree structure with parent/child references", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    const node1 = processed.nodeMap.get(1)!;
    const node2 = processed.nodeMap.get(2)!;
    const node3 = processed.nodeMap.get(3)!;

    expect(node1.children).toHaveLength(1);
    expect(node1.children[0].id).toBe(2);
    expect(node2.parent?.id).toBe(1);
    expect(node3.parent).toBeUndefined();
  });

  test("identifies root nodes", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    const rootIds = processed.roots.map(r => r.id).sort();
    expect(rootIds).toEqual([1, 3]);
  });

  test("calculates depth correctly", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    expect(processed.nodeMap.get(1)!.depth).toBe(0);
    expect(processed.nodeMap.get(2)!.depth).toBe(1);
    expect(processed.nodeMap.get(3)!.depth).toBe(0);
    expect(processed.maxDepth).toBe(1);
  });

  test("calculates sampling self-time from hitCount * interval", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    const node1 = processed.nodeMap.get(1)!;
    const node2 = processed.nodeMap.get(2)!;
    const node3 = processed.nodeMap.get(3)!;

    expect(node1.selfTime).toBe(5 * 100000);
    expect(node2.selfTime).toBe(20 * 100000);
    expect(node3.selfTime).toBe(10 * 100000);
  });

  test("calculates total-time as selfTime + sum of children totalTime", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    const node1 = processed.nodeMap.get(1)!;
    const node2 = processed.nodeMap.get(2)!;

    expect(node2.totalTime).toBe(2000000);
    expect(node1.totalTime).toBe(2500000);
  });

  test("calculates time percentages based on total self-time", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    const node2 = processed.nodeMap.get(2)!;
    // totalSelfTime = 500000+2000000+1000000 = 3500000
    expect(node2.selfTimePercent).toBeCloseTo(2000000 / 3500000 * 100, 1);
  });

  test("calculates instrumentation self-time from positionTicks executionTime", async () => {
    const parsed = await parseProfile(`${FIXTURES}/instrumentation-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    const node1 = processed.nodeMap.get(1)!;
    const node2 = processed.nodeMap.get(2)!;

    expect(node2.selfTime).toBe(350000);
    expect(node1.selfTime).toBe(500000);
  });

  test("works on real Session6 profile", async () => {
    const parsed = await parseProfile("exampledata/PerformanceProfile_Session6.alcpuprofile");
    const processed = processProfile(parsed);

    expect(processed.nodeCount).toBe(14);
    expect(processed.roots.length).toBeGreaterThan(0);
    const idle = processed.nodeMap.get(8)!;
    expect(idle.hitCount).toBe(19);
    expect(idle.selfTimePercent).toBeGreaterThan(50);
  });
});
