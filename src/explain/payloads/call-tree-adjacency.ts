import type { ProcessedNode, ProcessedProfile } from "../../types/processed.js";
import { isIdleNode } from "../../core/processor.js";

export interface AdjacencySummaryOptions {
  topMethods: number;
}

export interface AdjacencyEdge {
  method: string;
  objectType: string;
  objectId: number;
  appName: string;
  callCount: number;
  totalTime: number;
}

export interface AdjacencyEntry {
  method: string;
  objectType: string;
  objectId: number;
  appName: string;
  selfTime: number;
  totalTime: number;
  totalTimePercent: number;
  hitCount: number;
  callers: AdjacencyEdge[];
  callees: AdjacencyEdge[];
}

function methodKey(node: ProcessedNode): string {
  return `${node.callFrame.functionName}_${node.applicationDefinition.objectType}_${node.applicationDefinition.objectId}`;
}

interface AggregatedMethod {
  method: string;
  objectType: string;
  objectId: number;
  appName: string;
  selfTime: number;
  totalTime: number;
  totalTimePercent: number;
  hitCount: number;
  callerCounts: Map<string, { node: ProcessedNode; callCount: number; totalTime: number }>;
  calleeCounts: Map<string, { node: ProcessedNode; callCount: number; totalTime: number }>;
}

export function serializeAdjacencySummary(
  profile: ProcessedProfile,
  opts: AdjacencySummaryOptions,
): AdjacencyEntry[] {
  // Aggregate all non-idle nodes by method identity
  const aggregated = new Map<string, AggregatedMethod>();

  for (const node of profile.allNodes) {
    if (isIdleNode(node)) continue;

    const key = methodKey(node);
    let entry = aggregated.get(key);
    if (!entry) {
      entry = {
        method: node.callFrame.functionName,
        objectType: node.applicationDefinition.objectType,
        objectId: node.applicationDefinition.objectId,
        appName: node.declaringApplication?.appName ?? "",
        selfTime: 0,
        totalTime: 0,
        totalTimePercent: 0,
        hitCount: 0,
        callerCounts: new Map(),
        calleeCounts: new Map(),
      };
      aggregated.set(key, entry);
    }

    entry.selfTime += node.selfTime;
    entry.totalTime += node.totalTime;
    entry.totalTimePercent += node.totalTimePercent;
    entry.hitCount += node.hitCount;

    // Record caller (parent)
    if (node.parent && !isIdleNode(node.parent)) {
      const parentKey = methodKey(node.parent);
      const existing = entry.callerCounts.get(parentKey);
      if (existing) {
        existing.callCount += 1;
        existing.totalTime += node.totalTime;
      } else {
        entry.callerCounts.set(parentKey, { node: node.parent, callCount: 1, totalTime: node.totalTime });
      }
    }

    // Record callees (children)
    for (const child of node.children) {
      if (isIdleNode(child)) continue;
      const childKey = methodKey(child);
      const existing = entry.calleeCounts.get(childKey);
      if (existing) {
        existing.callCount += 1;
        existing.totalTime += child.totalTime;
      } else {
        entry.calleeCounts.set(childKey, { node: child, callCount: 1, totalTime: child.totalTime });
      }
    }
  }

  // Sort by selfTime descending, take top N
  const sorted = Array.from(aggregated.values())
    .sort((a, b) => b.selfTime - a.selfTime)
    .slice(0, opts.topMethods);

  return sorted.map((entry): AdjacencyEntry => ({
    method: entry.method,
    objectType: entry.objectType,
    objectId: entry.objectId,
    appName: entry.appName,
    selfTime: entry.selfTime,
    totalTime: entry.totalTime,
    totalTimePercent: entry.totalTimePercent,
    hitCount: entry.hitCount,
    callers: Array.from(entry.callerCounts.values()).map((c) => ({
      method: c.node.callFrame.functionName,
      objectType: c.node.applicationDefinition.objectType,
      objectId: c.node.applicationDefinition.objectId,
      appName: c.node.declaringApplication?.appName ?? "",
      callCount: c.callCount,
      totalTime: c.totalTime,
    })),
    callees: Array.from(entry.calleeCounts.values()).map((c) => ({
      method: c.node.callFrame.functionName,
      objectType: c.node.applicationDefinition.objectType,
      objectId: c.node.applicationDefinition.objectId,
      appName: c.node.declaringApplication?.appName ?? "",
      callCount: c.callCount,
      totalTime: c.totalTime,
    })),
  }));
}
