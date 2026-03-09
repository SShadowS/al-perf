import { describe, it, expect } from "bun:test";
import { extractCallGraph } from "../../../src/explain/payloads/call-graph.js";
import type { ProcessedNode } from "../../../src/types/processed.js";
import { parseProfile } from "../../../src/core/parser.js";
import { processProfile } from "../../../src/core/processor.js";

const FIXTURE = "test/fixtures/sampling-minimal.alcpuprofile";

function makeNode(
  overrides: Partial<{
    functionName: string;
    objectType: string;
    objectName: string;
    objectId: number;
    selfTime: number;
    totalTime: number;
    hitCount: number;
    parent: ProcessedNode;
    children: ProcessedNode[];
  }> = {},
): ProcessedNode {
  const node: ProcessedNode = {
    id: Math.random(),
    callFrame: {
      functionName: overrides.functionName ?? "TestMethod",
      scriptId: "",
      url: "",
      lineNumber: 0,
      columnNumber: 0,
    },
    applicationDefinition: {
      objectType: overrides.objectType ?? "CodeUnit",
      objectName: overrides.objectName ?? "TestCodeunit",
      objectId: overrides.objectId ?? 50100,
    },
    selfTime: overrides.selfTime ?? 0,
    totalTime: overrides.totalTime ?? 0,
    selfTimePercent: 0,
    totalTimePercent: 0,
    hitCount: overrides.hitCount ?? 1,
    children: overrides.children ?? [],
    parent: overrides.parent,
    depth: 0,
  };
  return node;
}

describe("extractCallGraph", () => {
  it("builds nodes from top N methods by selfTime", () => {
    const a = makeNode({ functionName: "A", objectId: 1, selfTime: 100 });
    const b = makeNode({ functionName: "B", objectId: 2, selfTime: 50 });
    const c = makeNode({ functionName: "C", objectId: 3, selfTime: 10 });

    const result = extractCallGraph([a, b, c], 2);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].method).toBe("A");
    expect(result.nodes[1].method).toBe("B");
  });

  it("filters out idle and root nodes", () => {
    const idle = makeNode({ functionName: "IdleTime", objectId: 0, selfTime: 9999 });
    const root = makeNode({ functionName: "(root)", objectId: 0, selfTime: 9999 });
    const idleParen = makeNode({ functionName: "(idle)", objectId: 0, selfTime: 9999 });
    const real = makeNode({ functionName: "RealMethod", objectId: 1, selfTime: 100 });

    const result = extractCallGraph([idle, root, idleParen, real], 10);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].method).toBe("RealMethod");
  });

  it("extracts edges when both caller and callee are in top set", () => {
    const parent = makeNode({ functionName: "Caller", objectId: 1, selfTime: 100 });
    const child = makeNode({
      functionName: "Callee",
      objectId: 2,
      selfTime: 80,
      totalTime: 80,
      parent,
    });
    parent.children = [child];

    const result = extractCallGraph([parent, child], 10);

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].caller).toBe("Caller");
    expect(result.edges[0].callee).toBe("Callee");
    expect(result.edges[0].callCount).toBe(1);
    expect(result.edges[0].totalTime).toBe(80);
  });

  it("does not create edges when one side is outside top set", () => {
    const parent = makeNode({ functionName: "Caller", objectId: 1, selfTime: 100 });
    const child = makeNode({
      functionName: "Callee",
      objectId: 2,
      selfTime: 1,
      totalTime: 1,
      parent,
    });
    parent.children = [child];

    // topN=1 means only "Caller" is in the set
    const result = extractCallGraph([parent, child], 1);

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  it("aggregates edges for same caller→callee pair across tree locations", () => {
    const parent1 = makeNode({ functionName: "Caller", objectId: 1, selfTime: 50 });
    const child1 = makeNode({
      functionName: "Callee",
      objectId: 2,
      selfTime: 40,
      totalTime: 30,
      parent: parent1,
    });
    parent1.children = [child1];

    const parent2 = makeNode({ functionName: "Caller", objectId: 1, selfTime: 50 });
    const child2 = makeNode({
      functionName: "Callee",
      objectId: 2,
      selfTime: 40,
      totalTime: 20,
      parent: parent2,
    });
    parent2.children = [child2];

    const result = extractCallGraph([parent1, child1, parent2, child2], 10);

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].callCount).toBe(2);
    expect(result.edges[0].totalTime).toBe(50);
  });

  it("aggregates node selfTime and hitCount across tree locations", () => {
    const a1 = makeNode({ functionName: "A", objectId: 1, selfTime: 60, hitCount: 3 });
    const a2 = makeNode({ functionName: "A", objectId: 1, selfTime: 40, hitCount: 2 });

    const result = extractCallGraph([a1, a2], 10);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].selfTime).toBe(100);
    expect(result.nodes[0].hitCount).toBe(5);
  });

  it("sorts edges by totalTime descending", () => {
    const a = makeNode({ functionName: "A", objectId: 1, selfTime: 100 });
    const b = makeNode({ functionName: "B", objectId: 2, selfTime: 80, totalTime: 20, parent: a });
    const c = makeNode({ functionName: "C", objectId: 3, selfTime: 60, totalTime: 50, parent: a });
    a.children = [b, c];

    const result = extractCallGraph([a, b, c], 10);

    expect(result.edges).toHaveLength(2);
    expect(result.edges[0].callee).toBe("C"); // higher totalTime
    expect(result.edges[1].callee).toBe("B");
  });

  it("works with a real profile fixture", async () => {
    const parsed = await parseProfile(FIXTURE);
    const profile = processProfile(parsed);

    const result = extractCallGraph(profile.allNodes, 10);

    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeLessThanOrEqual(10);

    for (const node of result.nodes) {
      expect(node.method).not.toBe("IdleTime");
      expect(node.method).not.toBe("(root)");
      expect(node.method).not.toBe("(idle)");
      expect(node.selfTime).toBeGreaterThanOrEqual(0);
    }

    // Edges should reference methods that exist in the node list
    const nodeMethods = new Set(result.nodes.map((n) => n.method));
    for (const edge of result.edges) {
      expect(nodeMethods.has(edge.caller)).toBe(true);
      expect(nodeMethods.has(edge.callee)).toBe(true);
    }
  });
});
