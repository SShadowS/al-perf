import { describe, it, expect } from "bun:test";
import { parseProfile } from "../../../src/core/parser.js";
import { processProfile } from "../../../src/core/processor.js";
import { serializePrunedTree, type PrunedTreeNode } from "../../../src/explain/payloads/call-tree-pruned.js";
import { serializeChainList } from "../../../src/explain/payloads/call-tree-chains.js";
import { serializeAdjacencySummary } from "../../../src/explain/payloads/call-tree-adjacency.js";
import type { ProcessedProfile } from "../../../src/types/processed.js";

const FIXTURE = "test/fixtures/sampling-minimal.alcpuprofile";

async function loadProfile(): Promise<ProcessedProfile> {
  const parsed = await parseProfile(FIXTURE);
  return processProfile(parsed);
}

describe("call-tree-pruned", () => {
  it("returns non-empty results for a valid profile", async () => {
    const profile = await loadProfile();
    const result = serializePrunedTree(profile, {
      maxSubtrees: 5,
      maxDepth: 10,
      minPercent: 0,
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty("method");
    expect(result[0]).toHaveProperty("objectType");
    expect(result[0]).toHaveProperty("objectId");
    expect(result[0]).toHaveProperty("appName");
    expect(result[0]).toHaveProperty("selfTime");
    expect(result[0]).toHaveProperty("totalTime");
    expect(result[0]).toHaveProperty("totalTimePercent");
    expect(result[0]).toHaveProperty("hitCount");
    expect(result[0]).toHaveProperty("children");
  });

  it("respects maxDepth", async () => {
    const profile = await loadProfile();
    const maxDepth = 2;
    const result = serializePrunedTree(profile, {
      maxSubtrees: 10,
      maxDepth,
      minPercent: 0,
    });

    function checkDepth(nodes: PrunedTreeNode[], depth: number): void {
      for (const node of nodes) {
        expect(depth).toBeLessThanOrEqual(maxDepth);
        checkDepth(node.children, depth + 1);
      }
    }

    checkDepth(result, 1);
  });

  it("respects maxSubtrees", async () => {
    const profile = await loadProfile();
    const result = serializePrunedTree(profile, {
      maxSubtrees: 1,
      maxDepth: 10,
      minPercent: 0,
    });

    expect(result.length).toBeLessThanOrEqual(1);
  });

  it("filters nodes below minPercent", async () => {
    const profile = await loadProfile();
    const minPercent = 50;
    const result = serializePrunedTree(profile, {
      maxSubtrees: 10,
      maxDepth: 10,
      minPercent,
    });

    function checkPercent(nodes: PrunedTreeNode[]): void {
      for (const node of nodes) {
        expect(node.totalTimePercent).toBeGreaterThanOrEqual(minPercent);
        checkPercent(node.children);
      }
    }

    checkPercent(result);
  });

  it("sorts children by totalTime descending", async () => {
    const profile = await loadProfile();
    const result = serializePrunedTree(profile, {
      maxSubtrees: 10,
      maxDepth: 10,
      minPercent: 0,
    });

    function checkSorted(nodes: PrunedTreeNode[]): void {
      for (let i = 1; i < nodes.length; i++) {
        expect(nodes[i - 1].totalTime).toBeGreaterThanOrEqual(nodes[i].totalTime);
      }
      for (const node of nodes) {
        checkSorted(node.children);
      }
    }

    checkSorted(result);
  });
});

describe("call-tree-chains", () => {
  it("returns non-empty results for a valid profile", async () => {
    const profile = await loadProfile();
    const result = serializeChainList(profile, { maxChains: 5 });

    expect(result.length).toBeGreaterThan(0);
    expect(Array.isArray(result[0])).toBe(true);
  });

  it("chain entries are flat arrays with expected fields", async () => {
    const profile = await loadProfile();
    const result = serializeChainList(profile, { maxChains: 5 });

    for (const chain of result) {
      expect(chain.length).toBeGreaterThan(0);
      for (const step of chain) {
        expect(step).toHaveProperty("method");
        expect(step).toHaveProperty("objectType");
        expect(step).toHaveProperty("objectId");
        expect(step).toHaveProperty("appName");
        expect(step).toHaveProperty("selfTime");
        expect(step).toHaveProperty("totalTime");
        expect(step).toHaveProperty("totalTimePercent");
        expect(step).toHaveProperty("hitCount");
        // Should not have children (flat, not tree)
        expect(step).not.toHaveProperty("children");
      }
    }
  });

  it("respects maxChains", async () => {
    const profile = await loadProfile();
    const result = serializeChainList(profile, { maxChains: 1 });

    expect(result.length).toBeLessThanOrEqual(1);
  });
});

describe("call-tree-adjacency", () => {
  it("returns non-empty results for a valid profile", async () => {
    const profile = await loadProfile();
    const result = serializeAdjacencySummary(profile, { topMethods: 5 });

    expect(result.length).toBeGreaterThan(0);
  });

  it("entries have expected fields and callers/callees arrays", async () => {
    const profile = await loadProfile();
    const result = serializeAdjacencySummary(profile, { topMethods: 5 });

    for (const entry of result) {
      expect(entry).toHaveProperty("method");
      expect(entry).toHaveProperty("objectType");
      expect(entry).toHaveProperty("objectId");
      expect(entry).toHaveProperty("appName");
      expect(entry).toHaveProperty("selfTime");
      expect(entry).toHaveProperty("totalTime");
      expect(entry).toHaveProperty("totalTimePercent");
      expect(entry).toHaveProperty("hitCount");
      expect(Array.isArray(entry.callers)).toBe(true);
      expect(Array.isArray(entry.callees)).toBe(true);

      for (const edge of [...entry.callers, ...entry.callees]) {
        expect(edge).toHaveProperty("method");
        expect(edge).toHaveProperty("objectType");
        expect(edge).toHaveProperty("objectId");
        expect(edge).toHaveProperty("appName");
        expect(edge).toHaveProperty("callCount");
        expect(edge).toHaveProperty("totalTime");
      }
    }
  });

  it("respects topMethods limit", async () => {
    const profile = await loadProfile();
    const result = serializeAdjacencySummary(profile, { topMethods: 2 });

    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("results are sorted by selfTime descending", async () => {
    const profile = await loadProfile();
    const result = serializeAdjacencySummary(profile, { topMethods: 10 });

    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].selfTime).toBeGreaterThanOrEqual(result[i].selfTime);
    }
  });
});
