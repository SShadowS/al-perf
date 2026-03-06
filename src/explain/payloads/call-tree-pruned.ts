import type { ProcessedNode, ProcessedProfile } from "../../types/processed.js";
import { isIdleNode } from "../../core/processor.js";

export interface PrunedTreeOptions {
  maxSubtrees: number;
  maxDepth: number;
  minPercent: number;
}

export interface PrunedTreeNode {
  method: string;
  objectType: string;
  objectId: number;
  appName: string;
  selfTime: number;
  totalTime: number;
  totalTimePercent: number;
  hitCount: number;
  children: PrunedTreeNode[];
}

function pruneNode(
  node: ProcessedNode,
  currentDepth: number,
  opts: PrunedTreeOptions,
): PrunedTreeNode | null {
  if (isIdleNode(node)) return null;
  if (currentDepth > opts.maxDepth) return null;
  if (node.totalTimePercent < opts.minPercent) return null;

  const children = currentDepth === opts.maxDepth ? [] : node.children
    .slice()
    .sort((a, b) => b.totalTime - a.totalTime)
    .map((child) => pruneNode(child, currentDepth + 1, opts))
    .filter((c): c is PrunedTreeNode => c !== null);

  return {
    method: node.callFrame.functionName,
    objectType: node.applicationDefinition.objectType,
    objectId: node.applicationDefinition.objectId,
    appName: node.declaringApplication?.appName ?? "",
    selfTime: node.selfTime,
    totalTime: node.totalTime,
    totalTimePercent: node.totalTimePercent,
    hitCount: node.hitCount,
    children,
  };
}

export function serializePrunedTree(
  profile: ProcessedProfile,
  opts: PrunedTreeOptions,
): PrunedTreeNode[] {
  const topRoots = profile.roots
    .filter((r) => !isIdleNode(r))
    .sort((a, b) => b.totalTime - a.totalTime)
    .slice(0, opts.maxSubtrees);

  return topRoots
    .map((root) => pruneNode(root, 1, opts))
    .filter((n): n is PrunedTreeNode => n !== null);
}
