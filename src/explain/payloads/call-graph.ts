import type { ProcessedNode } from "../../types/processed.js";
import { isIdleNode } from "../../core/processor.js";

export interface CallGraphNode {
  method: string;
  objectType: string;
  objectName: string;
  objectId: number;
  selfTime: number;
  hitCount: number;
}

export interface CallGraphEdge {
  caller: string;
  callerObject: string;
  callee: string;
  calleeObject: string;
  callCount: number;
  totalTime: number;
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

function nodeKey(node: ProcessedNode): string {
  return `${node.callFrame.functionName}|${node.applicationDefinition.objectType}|${node.applicationDefinition.objectId}`;
}

function isRootNode(node: ProcessedNode): boolean {
  return node.callFrame.functionName === "(root)" || node.callFrame.functionName === "(idle)";
}

function shouldExclude(node: ProcessedNode): boolean {
  return isIdleNode(node) || isRootNode(node);
}

export function extractCallGraph(allNodes: ProcessedNode[], topN: number): CallGraph {
  // 1. Aggregate all non-idle/root nodes by identity
  const aggregated = new Map<string, { selfTime: number; hitCount: number; node: ProcessedNode }>();

  for (const node of allNodes) {
    if (shouldExclude(node)) continue;

    const key = nodeKey(node);
    const existing = aggregated.get(key);
    if (existing) {
      existing.selfTime += node.selfTime;
      existing.hitCount += node.hitCount;
    } else {
      aggregated.set(key, { selfTime: node.selfTime, hitCount: node.hitCount, node });
    }
  }

  // 2. Sort by selfTime descending, take top N
  const sorted = Array.from(aggregated.entries())
    .sort((a, b) => b[1].selfTime - a[1].selfTime)
    .slice(0, topN);

  const topKeys = new Set(sorted.map(([key]) => key));

  // 3. Build node list
  const nodes: CallGraphNode[] = sorted.map(([, { selfTime, hitCount, node }]) => ({
    method: node.callFrame.functionName,
    objectType: node.applicationDefinition.objectType,
    objectName: node.applicationDefinition.objectName,
    objectId: node.applicationDefinition.objectId,
    selfTime,
    hitCount,
  }));

  // 4. Scan ALL nodes for edges where both parent and child are in the top set
  const edgeMap = new Map<string, CallGraphEdge>();

  for (const node of allNodes) {
    if (shouldExclude(node)) continue;
    if (!node.parent || shouldExclude(node.parent)) continue;

    const parentKey = nodeKey(node.parent);
    const childKey = nodeKey(node);

    if (!topKeys.has(parentKey) || !topKeys.has(childKey)) continue;

    const edgeId = `${parentKey}→${childKey}`;
    const existing = edgeMap.get(edgeId);
    if (existing) {
      existing.callCount += 1;
      existing.totalTime += node.totalTime;
    } else {
      edgeMap.set(edgeId, {
        caller: node.parent.callFrame.functionName,
        callerObject: `${node.parent.applicationDefinition.objectType} ${node.parent.applicationDefinition.objectId} ${node.parent.applicationDefinition.objectName}`,
        callee: node.callFrame.functionName,
        calleeObject: `${node.applicationDefinition.objectType} ${node.applicationDefinition.objectId} ${node.applicationDefinition.objectName}`,
        callCount: 1,
        totalTime: node.totalTime,
      });
    }
  }

  // 5. Sort edges by totalTime descending
  const edges = Array.from(edgeMap.values()).sort((a, b) => b.totalTime - a.totalTime);

  return { nodes, edges };
}
