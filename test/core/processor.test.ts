import { describe, test, expect } from "bun:test";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile, isIdleNode, countSampleAppearances } from "../../src/core/processor.js";
import type { ParsedProfile } from "../../src/types/profile.js";

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

  test("calculates sampling self-time from sample appearances when hitCount exceeds sample count", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    const node1 = processed.nodeMap.get(1)!;
    const node2 = processed.nodeMap.get(2)!;
    const node3 = processed.nodeMap.get(3)!;

    // sampling-minimal has hitCount sum 35 but only 5 samples, triggering sample-based calculation
    // samples=[2,2,3,2,2] => node1 appears 0 times, node2 appears 4 times, node3 appears 1 time
    expect(node1.selfTime).toBe(0 * 100000);
    expect(node2.selfTime).toBe(4 * 100000);
    expect(node3.selfTime).toBe(1 * 100000);
  });

  test("calculates total-time as selfTime + sum of children totalTime", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    const node1 = processed.nodeMap.get(1)!;
    const node2 = processed.nodeMap.get(2)!;

    // With sample-based calculation: node2.selfTime=400000, node1.selfTime=0
    expect(node2.totalTime).toBe(400000);
    expect(node1.totalTime).toBe(400000); // 0 + child's 400000
  });

  test("calculates time percentages based on active self-time (excluding idle)", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    const node2 = processed.nodeMap.get(2)!;
    // With sample-based calculation: activeSelfTime = 400000 (node2) + 0 (node1) = 400000
    // node2.selfTimePercent = 400000 / 400000 * 100 = 100
    expect(node2.selfTimePercent).toBeCloseTo(100, 1);
  });

  test("calculates instrumentation self-time from positionTicks executionTime", async () => {
    const parsed = await parseProfile(`${FIXTURES}/instrumentation-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    const node1 = processed.nodeMap.get(1)!;
    const node2 = processed.nodeMap.get(2)!;

    expect(node2.selfTime).toBe(350000);
    expect(node1.selfTime).toBe(500000);
  });

  test("works on sampling profile with idle nodes", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    expect(processed.nodeCount).toBe(3);
    expect(processed.roots.length).toBeGreaterThan(0);
    const idle = processed.nodeMap.get(3)!;
    expect(idle.hitCount).toBe(10);
    // Idle node percentages are zeroed out
    expect(idle.selfTimePercent).toBe(0);
  });

  test("separates activeSelfTime and idleSelfTime", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    // With sample-based: totalSelfTime = 0 + 400000 + 100000 = 500000
    expect(processed.totalSelfTime).toBe(500000);
    // idleSelfTime = 100000 (IdleTime node, 1 sample appearance)
    expect(processed.idleSelfTime).toBe(100000);
    // activeSelfTime = 400000
    expect(processed.activeSelfTime).toBe(400000);
  });

  test("idle node percentages are zero", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);

    const idleNode = processed.nodeMap.get(3)!;
    expect(isIdleNode(idleNode)).toBe(true);
    expect(idleNode.selfTimePercent).toBe(0);
    expect(idleNode.totalTimePercent).toBe(0);
  });

  test("preserves isBuiltinCodeUnitCall from raw node", async () => {
    const parsed = await parseProfile(`${FIXTURES}/instrumentation-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const node1 = processed.nodeMap.get(1)!;
    // instrumentation-minimal has isBuiltinCodeUnitCall: false on node 1
    expect(node1.isBuiltinCodeUnitCall).toBe(false);
  });

  test("uses sample appearances for selfTime when hitCount exceeds sample count", () => {
    // Synthetic profile simulating BC scheduled profiler mismatch:
    // hitCounts represent invocation counts (100 + 50 = 150), but only 3 samples
    const parsed: ParsedProfile = {
      type: "sampling",
      nodes: [
        {
          id: 1,
          callFrame: { functionName: "Root", scriptId: "CU_1", url: "", lineNumber: 0, columnNumber: 0 },
          hitCount: 0,
          children: [2, 3],
          applicationDefinition: { objectType: "CodeUnit", objectName: "Root", objectId: 1 },
          frameIdentifier: 1,
        },
        {
          id: 2,
          callFrame: { functionName: "ChildA", scriptId: "CU_1", url: "", lineNumber: 10, columnNumber: 0 },
          hitCount: 100,
          children: [],
          applicationDefinition: { objectType: "CodeUnit", objectName: "Root", objectId: 1 },
          frameIdentifier: 2,
        },
        {
          id: 3,
          callFrame: { functionName: "ChildB", scriptId: "CU_1", url: "", lineNumber: 20, columnNumber: 0 },
          hitCount: 50,
          children: [],
          applicationDefinition: { objectType: "CodeUnit", objectName: "Root", objectId: 1 },
          frameIdentifier: 3,
        },
      ],
      nodeMap: new Map(),
      rootNodes: [],
      startTime: 0,
      endTime: 3000,
      totalDuration: 3000,
      samples: [2, 2, 3],
      timeDeltas: [0, 1000, 1000],
      samplingInterval: 1000,
    };
    // Populate nodeMap and rootNodes for completeness
    for (const n of parsed.nodes) parsed.nodeMap.set(n.id, n);
    parsed.rootNodes = [parsed.nodes[0]];

    const processed = processProfile(parsed);

    // selfTime should be based on sample appearances, NOT hitCount
    // Node 2 appears 2 times in samples => selfTime = 2 * 1000 = 2000
    expect(processed.nodeMap.get(2)!.selfTime).toBe(2000);
    // Node 3 appears 1 time in samples => selfTime = 1 * 1000 = 1000
    expect(processed.nodeMap.get(3)!.selfTime).toBe(1000);
    // Node 1 appears 0 times in samples => selfTime = 0
    expect(processed.nodeMap.get(1)!.selfTime).toBe(0);
    // Total should be reasonable (3000), not wildly inflated (150000)
    expect(processed.totalSelfTime).toBe(3000);
  });

  test("normal sampling profile (hitCount matches samples) uses hitCount for selfTime", async () => {
    // The sampling-minimal fixture has hitCount sum (5+20+10=35) and 5 samples
    // 35 > 5*2=10, so this WILL trigger sample-based calculation too
    // But let's verify with a synthetic case where hitCount <= sampleCount * 2
    const parsed: ParsedProfile = {
      type: "sampling",
      nodes: [
        {
          id: 1,
          callFrame: { functionName: "Func", scriptId: "CU_1", url: "", lineNumber: 0, columnNumber: 0 },
          hitCount: 3,
          children: [],
          applicationDefinition: { objectType: "CodeUnit", objectName: "Func", objectId: 1 },
          frameIdentifier: 1,
        },
      ],
      nodeMap: new Map(),
      rootNodes: [],
      startTime: 0,
      endTime: 3000,
      totalDuration: 3000,
      samples: [1, 1, 1],
      timeDeltas: [0, 1000, 1000],
      samplingInterval: 1000,
    };
    for (const n of parsed.nodes) parsed.nodeMap.set(n.id, n);
    parsed.rootNodes = [parsed.nodes[0]];

    const processed = processProfile(parsed);

    // hitCount (3) <= sampleCount (3) * 2, so uses hitCount directly
    expect(processed.nodeMap.get(1)!.selfTime).toBe(3000);
  });
});

describe("countSampleAppearances", () => {
  test("counts each node ID in samples array", () => {
    const result = countSampleAppearances([2, 2, 3, 2, 1]);
    expect(result.get(2)).toBe(3);
    expect(result.get(3)).toBe(1);
    expect(result.get(1)).toBe(1);
    expect(result.get(99)).toBeUndefined();
  });

  test("returns empty map for empty samples", () => {
    const result = countSampleAppearances([]);
    expect(result.size).toBe(0);
  });
});
