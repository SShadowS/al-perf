import type { ParsedProfile, RawProfileNode } from "../types/profile.js";
import type { ProcessedNode, ProcessedProfile } from "../types/processed.js";
import { normalizeObjectType } from "./object-types.js";

export function isIdleNode(node: ProcessedNode): boolean {
  return node.callFrame.functionName === "IdleTime" && node.applicationDefinition.objectId === 0;
}

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
  // For sampling profiles, detect if hitCount represents invocation count rather than sample count.
  // BC scheduled profiler profiles can have hitCount >> samples.length, producing wildly wrong selfTime.
  let sampleAppearances: Map<number, number> | undefined;
  if (parsed.type === "sampling" && parsed.samples && parsed.samples.length > 0) {
    const totalHitCount = parsed.nodes.reduce((sum, n) => sum + n.hitCount, 0);
    if (totalHitCount > parsed.samples.length * 2) {
      sampleAppearances = countSampleAppearances(parsed.samples);
    }
  }
  for (const node of nodeMap.values()) {
    node.selfTime = calculateSelfTime(node, parsed, sampleAppearances);
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

  // Calculate percentages based on activeSelfTime (excluding idle nodes)
  const totalSelfTime = allNodes.reduce((sum, n) => sum + n.selfTime, 0);
  const idleSelfTime = allNodes.filter(isIdleNode).reduce((sum, n) => sum + n.selfTime, 0);
  const activeSelfTime = totalSelfTime - idleSelfTime;
  for (const node of allNodes) {
    if (isIdleNode(node)) {
      node.selfTimePercent = 0;
      node.totalTimePercent = 0;
    } else {
      node.selfTimePercent = activeSelfTime > 0 ? (node.selfTime / activeSelfTime) * 100 : 0;
      node.totalTimePercent = activeSelfTime > 0 ? (node.totalTime / activeSelfTime) * 100 : 0;
    }
  }

  return {
    type: parsed.type,
    roots,
    allNodes,
    nodeMap,
    totalDuration: parsed.totalDuration,
    totalSelfTime,
    activeSelfTime,
    idleSelfTime,
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
    applicationDefinition: {
      ...raw.applicationDefinition,
      objectType: normalizeObjectType(raw.applicationDefinition.objectType),
    },
    declaringApplication: raw.declaringApplication,
    hitCount: raw.hitCount,
    children: [],
    depth: 0,
    selfTime: 0,
    totalTime: 0,
    selfTimePercent: 0,
    totalTimePercent: 0,
    isBuiltinCodeUnitCall: raw.isBuiltinCodeUnitCall,
    positionTicks: raw.positionTicks,
    nodeStartTime: raw.startTime,
    nodeEndTime: raw.endTime,
  };
}

export function countSampleAppearances(samples: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const id of samples) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function calculateSelfTime(node: ProcessedNode, parsed: ParsedProfile, sampleAppearances?: Map<number, number>): number {
  if (parsed.type === "instrumentation" && node.positionTicks?.length) {
    return node.positionTicks.reduce((sum, pt) => sum + pt.executionTime, 0);
  }
  const interval = parsed.samplingInterval ?? 0;
  const count = sampleAppearances ? (sampleAppearances.get(node.id) ?? 0) : node.hitCount;
  return count * interval;
}
