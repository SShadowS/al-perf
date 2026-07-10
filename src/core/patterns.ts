import type { DetectedPattern, PatternDetector } from "../types/patterns.js";
import type { ProcessedNode, ProcessedProfile } from "../types/processed.js";
import { isIdleNode } from "./processor.js";

/**
 * Format a node reference as "FunctionName (ObjectType ObjectId)".
 */
export function formatMethodRef(node: ProcessedNode): string {
	const { functionName } = node.callFrame;
	const { objectType, objectId } = node.applicationDefinition;
	return `${functionName} (${objectType} ${objectId})`;
}

/**
 * Detect any single method consuming >50% of total selfTime.
 * Severity: critical.
 */
export const detectSingleMethodDominance: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	const patterns: DetectedPattern[] = [];

	for (const node of profile.allNodes) {
		if (isIdleNode(node)) continue;
		if (node.selfTimePercent > 50) {
			patterns.push({
				id: "single-method-dominance",
				severity: "critical",
				title: `${node.callFrame.functionName} dominates profile`,
				description: `${formatMethodRef(node)} accounts for ${node.selfTimePercent.toFixed(1)}% of total self-time.`,
				impact: node.selfTime,
				involvedMethods: [formatMethodRef(node)],
				evidence: `selfTimePercent = ${node.selfTimePercent.toFixed(1)}% (threshold: 50%)`,
				suggestion:
					"Investigate this method for tight computation loops or excessive calls. Consider caching results or reducing call frequency.",
			});
		}
	}

	return patterns;
};

/**
 * Detect disproportionate call counts.
 *
 * .alcpuprofile: child nodes where hitCount > parent.hitCount * 10 (hitCount
 * is a sample count on sampling profiles — statistical inference).
 *
 * ir-json: every node is ONE invocation (hitCount == 1), so the hitCount
 * heuristic is inert. Instead measure EXACT call amplification: total child
 * invocations per distinct parent invocation, per (parent method -> child
 * method) edge.
 *
 * Severity: warning.
 */
export const detectHighHitCount: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	if (profile.sourceFormat === "ir-json") {
		return detectHighFanOutExact(profile);
	}

	const patterns: DetectedPattern[] = [];

	for (const node of profile.allNodes) {
		if (isIdleNode(node)) continue;
		if (
			node.parent &&
			node.parent.hitCount > 0 &&
			node.hitCount > node.parent.hitCount * 10
		) {
			patterns.push({
				id: "high-hit-count",
				severity: "warning",
				title: `${node.callFrame.functionName} has disproportionate hit count`,
				description: `${formatMethodRef(node)} has ${node.hitCount} hits vs parent ${formatMethodRef(node.parent)} with ${node.parent.hitCount} hits (ratio ${(node.hitCount / node.parent.hitCount).toFixed(1)}x).`,
				impact: node.selfTime,
				involvedMethods: [formatMethodRef(node), formatMethodRef(node.parent)],
				evidence: `hitCount ratio = ${(node.hitCount / node.parent.hitCount).toFixed(1)}x (threshold: 10x)`,
				suggestion:
					"High hit count suggests this method is called very frequently. Check if callers can batch operations or if an event subscriber is firing too often.",
			});
		}
	}

	return patterns;
};

/**
 * Compute exact call-count amplification on ir-json profiles, per (parent
 * method -> child method) edge.
 *
 * Denominator semantic: the fan-out ratio is `childCount / callingParentCount`,
 * where `callingParentCount` counts only the DISTINCT parent invocations
 * that made at least one call to the child on this edge — NOT the total
 * number of invocations of the parent method. This is deliberate: a parent
 * method that runs 500 times but only calls the child from 2 of those
 * invocations (11x each) is still an N+1 hotspot at those 2 call sites.
 * Averaging over the other 498 invocations that never touch the child would
 * dilute the ratio below the 10x threshold and hide the pattern. The total
 * invocation count of the parent method is tracked separately and disclosed
 * in the description/evidence text so the wording never implies the ratio
 * is a global average — it is a per-calling-invocation fan-out.
 */
function detectHighFanOutExact(profile: ProcessedProfile): DetectedPattern[] {
	interface FanOutEdge {
		childCount: number;
		parentIds: Set<number>;
		child: ProcessedNode;
		parent: ProcessedNode;
		impact: number;
	}
	const edges = new Map<string, FanOutEdge>();
	const methodTotalCounts = new Map<string, number>();

	for (const node of profile.allNodes) {
		if (isIdleNode(node)) continue;
		const key = `${node.callFrame.functionName}:${node.applicationDefinition.objectId}`;
		methodTotalCounts.set(key, (methodTotalCounts.get(key) ?? 0) + 1);
	}

	for (const node of profile.allNodes) {
		if (isIdleNode(node) || !node.parent) continue;
		const childKey = `${node.callFrame.functionName}:${node.applicationDefinition.objectId}`;
		const parentKey = `${node.parent.callFrame.functionName}:${node.parent.applicationDefinition.objectId}`;
		const key = `${parentKey}=>${childKey}`;
		let edge = edges.get(key);
		if (!edge) {
			edge = {
				childCount: 0,
				parentIds: new Set(),
				child: node,
				parent: node.parent,
				impact: 0,
			};
			edges.set(key, edge);
		}
		edge.childCount++;
		edge.parentIds.add(node.parent.id);
		edge.impact += node.selfTime;
	}

	const patterns: DetectedPattern[] = [];
	for (const edge of edges.values()) {
		const callingParentCount = edge.parentIds.size;
		const ratio = edge.childCount / callingParentCount;
		if (ratio > 10) {
			const parentKey = `${edge.parent.callFrame.functionName}:${edge.parent.applicationDefinition.objectId}`;
			const totalParentCount =
				methodTotalCounts.get(parentKey) ?? callingParentCount;
			patterns.push({
				id: "high-hit-count",
				severity: "warning",
				title: `${edge.child.callFrame.functionName} has disproportionate invocation count`,
				description: `${formatMethodRef(edge.child)} was invoked exactly ${edge.childCount} times across ${callingParentCount} calling invocation(s) of ${formatMethodRef(edge.parent)} (${edge.parent.callFrame.functionName} ran ${totalParentCount} time(s) total) — ${ratio.toFixed(1)}x fan-out per calling invocation.`,
				impact: edge.impact,
				involvedMethods: [
					formatMethodRef(edge.child),
					formatMethodRef(edge.parent),
				],
				evidence: `exact invocation counts: ${edge.childCount} calls / ${callingParentCount} calling invocation(s) of ${totalParentCount} total invocation(s) of ${formatMethodRef(edge.parent)} = ${ratio.toFixed(1)}x fan-out per calling invocation (threshold: 10x)`,
				suggestion:
					"High invocation count suggests this method is called very frequently. Check if callers can batch operations or if an event subscriber is firing too often.",
			});
		}
	}
	return patterns;
}

/**
 * Detect profiles with maxDepth > 30.
 * Severity: warning.
 */
export const detectDeepCallStack: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	if (profile.maxDepth <= 30) return [];

	// Find the deepest node(s)
	const deepestNodes = profile.allNodes.filter(
		(n) => n.depth === profile.maxDepth,
	);
	const involvedMethods = deepestNodes.slice(0, 5).map(formatMethodRef);

	return [
		{
			id: "deep-call-stack",
			severity: "warning",
			title: `Call stack depth of ${profile.maxDepth} detected`,
			description: `Profile has a maximum call stack depth of ${profile.maxDepth}, which may indicate deep recursion or excessive nesting.`,
			impact: deepestNodes.reduce((sum, n) => sum + n.selfTime, 0),
			involvedMethods,
			evidence: `maxDepth = ${profile.maxDepth} (threshold: 30)`,
			suggestion:
				"Deep call stacks can indicate excessive indirection. Review the call chain for unnecessary layers or consider flattening the architecture.",
		},
	];
};

/**
 * Detect parents with 50+ children sharing the same functionName+objectId.
 * Severity: critical.
 */
export const detectRepeatedSiblings: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	const patterns: DetectedPattern[] = [];

	for (const node of profile.allNodes) {
		if (isIdleNode(node)) continue;
		if (node.children.length < 50) continue;

		// Group children by functionName+objectId
		const groups = new Map<string, ProcessedNode[]>();
		for (const child of node.children) {
			const key = `${child.callFrame.functionName}:${child.applicationDefinition.objectId}`;
			const group = groups.get(key);
			if (group) {
				group.push(child);
			} else {
				groups.set(key, [child]);
			}
		}

		for (const [, group] of groups) {
			if (group.length >= 50) {
				const representative = group[0];
				const totalImpact = group.reduce((sum, n) => sum + n.totalTime, 0);
				const exact = profile.sourceFormat === "ir-json";
				patterns.push({
					id: "repeated-siblings",
					severity: "critical",
					title: `${representative.callFrame.functionName} called ${group.length} times under ${node.callFrame.functionName}`,
					description: exact
						? `${formatMethodRef(node)} invoked ${formatMethodRef(representative)} exactly ${group.length} times (exact invocation count from instrumentation capture) — a loop or repeated invocation pattern.`
						: `${formatMethodRef(node)} has ${group.length} child calls to ${formatMethodRef(representative)}, suggesting a loop or repeated invocation pattern.`,
					impact: totalImpact,
					involvedMethods: [
						formatMethodRef(node),
						formatMethodRef(representative),
					],
					evidence: exact
						? `${group.length} sibling invocations with same functionName+objectId (exact invocation count, threshold: 50)`
						: `${group.length} sibling calls with same functionName+objectId (threshold: 50)`,
					suggestion:
						"The same method is called repeatedly at the same call site. Consider batching these calls or caching the result.",
				});
			}
		}
	}

	return patterns;
};

/**
 * Detect event subscriber hotspots: methods starting with OnBefore/OnAfter/HandleOn
 * that collectively consume >10% of total selfTime.
 * Severity: warning.
 */
export const detectEventSubscriberHotspot: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	const eventPrefixes = ["OnBefore", "OnAfter", "HandleOn"];

	const eventNodes = profile.allNodes.filter((node) =>
		eventPrefixes.some((prefix) =>
			node.callFrame.functionName.startsWith(prefix),
		),
	);

	if (eventNodes.length === 0) return [];

	const totalSelfTimePercent = eventNodes.reduce(
		(sum, n) => sum + n.selfTimePercent,
		0,
	);

	if (totalSelfTimePercent <= 10) return [];

	const totalImpact = eventNodes.reduce((sum, n) => sum + n.selfTime, 0);
	const involvedMethods = eventNodes.map(formatMethodRef);

	return [
		{
			id: "event-subscriber-hotspot",
			severity: "warning",
			title: `Event subscribers consume ${totalSelfTimePercent.toFixed(1)}% of self-time`,
			description: `${eventNodes.length} event subscriber methods (OnBefore/OnAfter/HandleOn) collectively account for ${totalSelfTimePercent.toFixed(1)}% of total self-time.`,
			impact: totalImpact,
			involvedMethods,
			evidence: `Combined selfTimePercent = ${totalSelfTimePercent.toFixed(1)}% across ${eventNodes.length} methods (threshold: 10%)`,
			suggestion:
				"This event subscriber is consuming significant time. Review whether it needs to run for every event, or if it can be filtered or optimized.",
		},
	];
};

/**
 * Detect recursive calls: a method that appears as its own ancestor.
 * Severity: warning.
 */
export const detectRecursion: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	const reported = new Set<string>();
	const patterns: DetectedPattern[] = [];

	for (const node of profile.allNodes) {
		if (isIdleNode(node)) continue;
		const key = `${node.callFrame.functionName}:${node.applicationDefinition.objectId}`;
		if (reported.has(key)) continue;

		// Walk up ancestors to check for same method
		let ancestor = node.parent;
		let depth = 0;
		while (ancestor) {
			if (
				ancestor.callFrame.functionName === node.callFrame.functionName &&
				ancestor.applicationDefinition.objectId ===
					node.applicationDefinition.objectId
			) {
				reported.add(key);

				const allInstances = profile.allNodes.filter(
					(n) =>
						n.callFrame.functionName === node.callFrame.functionName &&
						n.applicationDefinition.objectId ===
							node.applicationDefinition.objectId,
				);
				const totalImpact = allInstances.reduce(
					(sum, n) => sum + n.selfTime,
					0,
				);

				patterns.push({
					id: "recursive-call",
					severity: "warning",
					title: `${node.callFrame.functionName} calls itself recursively (depth ${depth + 1}+)`,
					description: `${formatMethodRef(node)} appears ${allInstances.length} times in the call tree as a recursive chain.`,
					impact: totalImpact,
					involvedMethods: [formatMethodRef(node)],
					evidence: `${allInstances.length} instances of the same method in ancestor-descendant relationships`,
					suggestion:
						"Recursive calls in AL often indicate unintentional trigger chains or BOM explosion patterns. Consider iterative approaches or caching to limit recursion depth.",
				});
				break;
			}
			ancestor = ancestor.parent;
			depth++;
		}
	}

	return patterns;
};

/**
 * Detect expensive event chains: when event subscriber methods (OnBefore*, OnAfter*, HandleOn*)
 * form chains where a subscriber triggers another subscriber.
 */
export const detectEventChains: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	const patterns: DetectedPattern[] = [];
	const eventPattern = /^(OnBefore|OnAfter|HandleOn)/i;

	// Find all event subscriber nodes
	const eventNodes = profile.allNodes.filter(
		(n) => !isIdleNode(n) && eventPattern.test(n.callFrame.functionName),
	);

	if (eventNodes.length < 2) return patterns;

	// Group by root event subscriber: find nodes where an event subscriber calls another
	const chains = new Map<
		string,
		{ root: ProcessedNode; chain: ProcessedNode[]; totalTime: number }
	>();

	for (const node of eventNodes) {
		// Walk up to find if any ancestor is also an event subscriber
		let ancestor = node.parent;
		while (ancestor) {
			if (
				!isIdleNode(ancestor) &&
				eventPattern.test(ancestor.callFrame.functionName)
			) {
				const rootKey = `${ancestor.callFrame.functionName}_${ancestor.applicationDefinition.objectId}_${ancestor.id}`;
				let chain = chains.get(rootKey);
				if (!chain) {
					chain = {
						root: ancestor,
						chain: [ancestor],
						totalTime: ancestor.totalTime,
					};
					chains.set(rootKey, chain);
				}
				if (!chain.chain.includes(node)) {
					chain.chain.push(node);
				}
				break;
			}
			ancestor = ancestor.parent;
		}
	}

	// Report chains with 2+ event subscribers
	for (const [_, chain] of chains) {
		if (chain.chain.length < 2) continue;
		const methods = chain.chain.map((n) => formatMethodRef(n));
		patterns.push({
			id: "event-chain",
			severity: "warning",
			title: `Event chain from ${chain.root.callFrame.functionName} (${chain.chain.length} subscribers)`,
			description: `Event subscriber ${formatMethodRef(chain.root)} triggers a chain of ${chain.chain.length} nested event subscribers, compounding execution cost.`,
			impact: chain.totalTime,
			involvedMethods: methods,
			evidence: `${chain.chain.length} nested event subscriber calls`,
			suggestion:
				"Review whether all subscribers in this chain are necessary. Consider consolidating event handlers or reducing the chain depth.",
		});
	}

	return patterns;
};

/**
 * All built-in pattern detectors.
 */
const allDetectors: PatternDetector[] = [
	detectSingleMethodDominance,
	detectHighHitCount,
	detectDeepCallStack,
	detectRepeatedSiblings,
	detectEventSubscriberHotspot,
	detectRecursion,
	detectEventChains,
];

/**
 * Run all pattern detectors and return results sorted by impact descending.
 */
export function runDetectors(profile: ProcessedProfile): DetectedPattern[] {
	const patterns: DetectedPattern[] = [];

	for (const detector of allDetectors) {
		patterns.push(...detector(profile));
	}

	patterns.sort((a, b) => b.impact - a.impact);

	return patterns;
}
