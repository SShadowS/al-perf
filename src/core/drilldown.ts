import { parseProfile } from "./parser.js";
import { processProfile, isIdleNode } from "./processor.js";
import type { SubtreeDrillDown, ChildContribution } from "../output/types.js";

export async function drilldownMethod(
  filePath: string,
  methodName: string,
  objectId?: number,
): Promise<SubtreeDrillDown | null> {
  const parsed = await parseProfile(filePath);
  const processed = processProfile(parsed);

  // Find all nodes matching the method
  const matchingNodes = processed.allNodes.filter(n => {
    if (isIdleNode(n)) return false;
    const nameMatch = n.callFrame.functionName.toLowerCase() === methodName.toLowerCase();
    if (!nameMatch) return false;
    if (objectId !== undefined && n.applicationDefinition.objectId !== objectId) return false;
    return true;
  });

  if (matchingNodes.length === 0) return null;

  // Pick the one with highest selfTime
  const primaryNode = matchingNodes.sort((a, b) => b.selfTime - a.selfTime)[0];

  // Aggregate child contributions across all instances of this method
  const childMap = new Map<string, ChildContribution>();
  let totalSelfTime = 0;
  let totalTotalTime = 0;
  let totalHitCount = 0;

  for (const node of matchingNodes) {
    totalSelfTime += node.selfTime;
    totalTotalTime += node.totalTime;
    totalHitCount += node.hitCount;

    for (const child of node.children) {
      if (isIdleNode(child)) continue;
      const key = `${child.callFrame.functionName}_${child.applicationDefinition.objectType}_${child.applicationDefinition.objectId}`;
      let entry = childMap.get(key);
      if (!entry) {
        entry = {
          functionName: child.callFrame.functionName,
          objectType: child.applicationDefinition.objectType,
          objectId: child.applicationDefinition.objectId,
          appName: child.declaringApplication?.appName ?? "(System)",
          totalTime: 0,
          contributionPercent: 0,
          hitCount: 0,
        };
        childMap.set(key, entry);
      }
      entry.totalTime += child.totalTime;
      entry.hitCount += child.hitCount;
    }
  }

  // Calculate contribution percentages
  const children = Array.from(childMap.values());
  for (const child of children) {
    child.contributionPercent = totalTotalTime > 0
      ? (child.totalTime / totalTotalTime) * 100
      : 0;
  }
  children.sort((a, b) => b.totalTime - a.totalTime);

  return {
    method: {
      functionName: primaryNode.callFrame.functionName,
      objectType: primaryNode.applicationDefinition.objectType,
      objectId: primaryNode.applicationDefinition.objectId,
      appName: primaryNode.declaringApplication?.appName ?? "(System)",
      selfTime: totalSelfTime,
      totalTime: totalTotalTime,
      totalTimePercent: primaryNode.totalTimePercent,
      hitCount: totalHitCount,
    },
    breakdown: {
      selfTimeInMethod: totalSelfTime,
      selfTimePercent: totalTotalTime > 0 ? (totalSelfTime / totalTotalTime) * 100 : 0,
      childContributions: children,
    },
  };
}
