import type { ChildContribution, SubtreeDrillDown } from "../output/types.js";
import { hasSameMethodAncestor } from "./aggregator.js";
import { parseProfile } from "./parser.js";
import { isIdleNode, processProfile } from "./processor.js";

export async function drilldownMethod(
	filePath: string,
	methodName: string,
	objectId?: number,
): Promise<SubtreeDrillDown | null> {
	const parsed = await parseProfile(filePath);
	const processed = processProfile(parsed);

	// Find all nodes matching the method
	const matchingNodes = processed.allNodes.filter((n) => {
		if (isIdleNode(n)) return false;
		const nameMatch =
			n.callFrame.functionName.toLowerCase() === methodName.toLowerCase();
		if (!nameMatch) return false;
		if (objectId !== undefined && n.applicationDefinition.objectId !== objectId)
			return false;
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

	const methodKey = `${primaryNode.callFrame.functionName}_${primaryNode.applicationDefinition.objectType}_${primaryNode.applicationDefinition.objectId}`;

	for (const node of matchingNodes) {
		totalSelfTime += node.selfTime;
		// Outermost occurrences only — a node's totalTime already contains its
		// descendants', so summing every level of a recursive call charges the
		// same microseconds repeatedly. selfTime and hitCount are disjoint per
		// node and still sum. Same rule aggregateByMethod applies.
		if (!hasSameMethodAncestor(node, methodKey)) {
			totalTotalTime += node.totalTime;
		}
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
		child.contributionPercent =
			totalTotalTime > 0 ? (child.totalTime / totalTotalTime) * 100 : 0;
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
			// Derived from the total reported RIGHT ABOVE it. This used to read
			// `primaryNode.totalTimePercent` — one node's share sitting next to a
			// figure summed over all of them, so the value and its percentage
			// described different scopes and disagreed with explain_method.
			totalTimePercent:
				processed.activeSelfTime > 0
					? (totalTotalTime / processed.activeSelfTime) * 100
					: 0,
			hitCount: totalHitCount,
		},
		breakdown: {
			selfTimeInMethod: totalSelfTime,
			selfTimePercent:
				totalTotalTime > 0 ? (totalSelfTime / totalTotalTime) * 100 : 0,
			childContributions: children,
		},
	};
}
