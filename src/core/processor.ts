import type { ParsedProfile, RawProfileNode } from "../types/profile.js";
import type { ProcessedNode, ProcessedProfile } from "../types/processed.js";

export function processProfile(parsed: ParsedProfile): ProcessedProfile {
  const nodeMap = new Map<number, ProcessedNode>();
  for (const raw of parsed.nodes) {
    nodeMap.set(raw.id, createProcessedNode(raw));
  }

  // Wire parent/child references
  for (const raw of parsed.nodes) {
    const node = nodeMap.get(raw.id)!;
    for (const childId of raw.children) {
      const child = nodeMap.get(childId);
      if (child) {
        node.children.push(child);
        child.parent = node;
      }
    }
  }

  // Find roots (nodes with no parent), set depths
  const roots: ProcessedNode[] = [];
  for (const node of nodeMap.values()) {
    if (!node.parent) roots.push(node);
  }

  let maxDepth = 0;
  function setDepths(node: ProcessedNode, depth: number): void {
    node.depth = depth;
    if (depth > maxDepth) maxDepth = depth;
    for (const child of node.children) {
      setDepths(child, depth + 1);
    }
  }
  for (const root of roots) setDepths(root, 0);

  // Calculate selfTime
  for (const node of nodeMap.values()) {
    node.selfTime = calculateSelfTime(node, parsed);
  }

  // Calculate totalTime bottom-up (deepest nodes first)
  const allNodes = Array.from(nodeMap.values());
  const byDepthDesc = [...allNodes].sort((a, b) => b.depth - a.depth);
  for (const node of byDepthDesc) {
    node.totalTime = node.selfTime;
    for (const child of node.children) {
      node.totalTime += child.totalTime;
    }
  }

  // Calculate percentages based on totalSelfTime
  const totalSelfTime = allNodes.reduce((sum, n) => sum + n.selfTime, 0);
  for (const node of allNodes) {
    node.selfTimePercent = totalSelfTime > 0 ? (node.selfTime / totalSelfTime) * 100 : 0;
    node.totalTimePercent = totalSelfTime > 0 ? (node.totalTime / totalSelfTime) * 100 : 0;
  }

  return {
    type: parsed.type,
    roots,
    allNodes,
    nodeMap,
    totalDuration: parsed.totalDuration,
    totalSelfTime,
    maxDepth,
    samplingInterval: parsed.samplingInterval,
    nodeCount: allNodes.length,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
  };
}

function createProcessedNode(raw: RawProfileNode): ProcessedNode {
  return {
    id: raw.id,
    callFrame: raw.callFrame,
    applicationDefinition: raw.applicationDefinition,
    declaringApplication: raw.declaringApplication,
    hitCount: raw.hitCount,
    children: [],
    depth: 0,
    selfTime: 0,
    totalTime: 0,
    selfTimePercent: 0,
    totalTimePercent: 0,
    positionTicks: raw.positionTicks,
    nodeStartTime: raw.startTime,
    nodeEndTime: raw.endTime,
  };
}

function calculateSelfTime(node: ProcessedNode, parsed: ParsedProfile): number {
  if (parsed.type === "instrumentation" && node.positionTicks?.length) {
    return node.positionTicks.reduce((sum, pt) => sum + pt.executionTime, 0);
  }
  const interval = parsed.samplingInterval ?? 0;
  return node.hitCount * interval;
}
