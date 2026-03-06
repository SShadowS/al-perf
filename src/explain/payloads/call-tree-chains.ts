import type { ProcessedNode, ProcessedProfile } from "../../types/processed.js";
import { isIdleNode } from "../../core/processor.js";

export interface ChainListOptions {
  maxChains: number;
}

export interface ChainStep {
  method: string;
  objectType: string;
  objectId: number;
  appName: string;
  selfTime: number;
  totalTime: number;
  totalTimePercent: number;
  hitCount: number;
}

function nodeToStep(node: ProcessedNode): ChainStep {
  return {
    method: node.callFrame.functionName,
    objectType: node.applicationDefinition.objectType,
    objectId: node.applicationDefinition.objectId,
    appName: node.declaringApplication?.appName ?? "",
    selfTime: node.selfTime,
    totalTime: node.totalTime,
    totalTimePercent: node.totalTimePercent,
    hitCount: node.hitCount,
  };
}

/**
 * Extract the heaviest root-to-leaf path starting from the given node
 * by always following the child with the highest totalTime.
 */
function extractHeaviestChain(root: ProcessedNode): ChainStep[] {
  const chain: ChainStep[] = [];
  let current: ProcessedNode | undefined = root;

  while (current) {
    chain.push(nodeToStep(current));

    // Pick heaviest non-idle child
    const candidates = current.children
      .filter((c) => !isIdleNode(c))
      .sort((a, b) => b.totalTime - a.totalTime);

    current = candidates.length > 0 ? candidates[0] : undefined;
  }

  return chain;
}

export function serializeChainList(
  profile: ProcessedProfile,
  opts: ChainListOptions,
): ChainStep[][] {
  const roots = profile.roots
    .filter((r) => !isIdleNode(r))
    .sort((a, b) => b.totalTime - a.totalTime)
    .slice(0, opts.maxChains);

  return roots.map((root) => extractHeaviestChain(root));
}
