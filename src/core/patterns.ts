import { formatMethodBreakdownRef } from "./method-ref.js";

export { formatMethodBreakdownRef };

import type { DetectedPattern, PatternDetector } from "../types/patterns.js";
import type { ProcessedNode, ProcessedProfile } from "../types/processed.js";
import { aggregateByMethod } from "./aggregator.js";
import { isSqlStatement } from "./display-utils.js";
import { isIdleNode } from "./processor.js";
import {
	classifySqlOperation,
	isSqlFunctionName,
	parseSqlTable,
} from "./sql-node.js";

/**
 * A node's name as it may appear in HUMAN-FACING finding text — title,
 * description, evidence.
 *
 * A BC sampling profile embeds SQL statements as call-tree nodes whose
 * `functionName` IS the statement text, company- and database-qualified:
 * `SELECT L.Text FROM [CRONUS].[dbo].[$ndo$textlookup] ...`. `evaluate.ts`
 * copies a pattern's title into the finding, and the GitHub/Azure DevOps
 * sinks put that straight into the issue title — so a raw statement publishes
 * the customer's database and company name to an external tracker. That is
 * exactly what `redactSqlForSink` prevents on the telemetry path; the profile
 * path had no equivalent.
 *
 * `parseSqlTable` already strips the company prefix (`Company$Table` -> the
 * logical table), so the operation plus that table is both safe and more
 * readable than 300 characters of SQL.
 *
 * NOT used for `involvedMethods`: that is the fingerprint anchor
 * (`resolvePatternAnchor`), rewriting it would churn the identity of every
 * SQL finding, and it never reaches a sink — the issue body carries title,
 * severity, state, patternId, fingerprint, appName and evidence only.
 */
export function displayFunctionName(node: ProcessedNode): string {
	return displaySqlName(node.callFrame.functionName);
}

/**
 * The same redaction keyed off a function NAME alone, for callers holding an
 * aggregated `MethodBreakdown` rather than a `ProcessedNode` — the summary
 * one-liner, which leads every output format and every MCP analyze_profile
 * response.
 */
export function displaySqlName(name: string): string {
	// Deliberately the BROADER of the codebase's two SQL recognizers.
	// `isSqlNode` matches SELECT/INSERT/UPDATE/DELETE/MERGE only, and BC also
	// emits `IF EXISTS(SELECT ...)`, `EXEC ...` and `BEGIN ...` nodes — one of
	// which slipped through this guard carrying a company-qualified table.
	// Redaction must be gated on the widest recognizer, not the narrowest.
	if (!isSqlStatement(name) && !isSqlFunctionName(name)) return name;
	const { table } = parseSqlTable(name);
	const operation = classifySqlOperation(name);
	// `classifySqlOperation` returns OTHER for the forms it has no case for;
	// "OTHER statement" tells the reader nothing, so name it plainly.
	const label = operation === "OTHER" ? "SQL statement" : operation;
	return table ? `${label} on "${table}"` : label;
}

/** `formatMethodRef` for human-facing text: SQL nodes get their redacted descriptor. */
export function displayMethodRef(node: ProcessedNode): string {
	const { objectType, objectId } = node.applicationDefinition;
	return `${displayFunctionName(node)} (${objectType} ${objectId})`;
}

/**
 * Format a node reference as "FunctionName (ObjectType ObjectId)".
 */
export function formatMethodRef(node: ProcessedNode): string {
	const { functionName } = node.callFrame;
	const { objectType, objectId } = node.applicationDefinition;
	return `${functionName} (${objectType} ${objectId})`;
}

function callSiteWord(count: number): string {
	return count === 1 ? "call site" : "call sites";
}

function methodWord(count: number): string {
	return count === 1 ? "method" : "methods";
}

const SEVERITY_ORDER: Record<DetectedPattern["severity"], number> = {
	critical: 3,
	warning: 2,
	info: 1,
};

/**
 * Impact first (real measured time from the profile), then severity, then id.
 *
 * Source-only detectors have no profile and therefore no measured impact — they
 * all emit impact 0. Sorting on impact alone left the entire source-only category
 * tied at zero, in arbitrary order, so a theoretical 3x3 nested loop ranked
 * identically to the real bottleneck.
 *
 * The fallback is severity, NOT a synthesized impact score. Inventing a number
 * would produce something that looks like measured time and is not.
 *
 * The id tiebreak makes the order deterministic, so output does not churn between
 * runs on equal findings.
 *
 * The id tiebreak is a codepoint comparison (`<`/`>`), NOT `localeCompare()`.
 * Pattern ids are ASCII kebab-case, so locale-aware collation is the wrong
 * tool: `localeCompare()` with no locale argument resolves the host's
 * *ambient default locale*, and collation order is locale-dependent. Under
 * Danish (da-DK) collation, "aa" is treated as a variant of "å", which sorts
 * AFTER "z" — so an id starting with "aa" would rank after one starting with
 * "z" on a Danish host, and before it everywhere else. A "deterministic
 * tiebreak" that silently reorders with the ambient host locale is not
 * deterministic. Codepoint comparison has no ICU dependency and cannot drift.
 *
 * This is the ONE comparator for every pattern list in the codebase — used by
 * runDetectors (below), runSourceDetectors (source/source-patterns.ts),
 * runSourceOnlyDetectors (source/source-only-patterns.ts), the merge in
 * analyzeProfile (core/analyzer.ts) that combines the two, and the
 * analyze-source CLI command — so none of those call sites can drift apart.
 */
export function sortPatterns(patterns: DetectedPattern[]): DetectedPattern[] {
	return [...patterns].sort(
		(a, b) =>
			b.impact - a.impact ||
			SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
}

/**
 * Group key for a profile node's method. MUST match aggregateByMethod's key
 * (src/core/aggregator.ts) so per-method call-site counts line up with the
 * aggregate they describe.
 */
function methodGroupKey(node: ProcessedNode): string {
	const { objectType, objectId } = node.applicationDefinition;
	return `${node.callFrame.functionName}_${objectType}_${objectId}`;
}

/**
 * Detect any single method consuming >50% of total selfTime, aggregated
 * across all of its call sites.
 *
 * A profile node is one call site — the same method invoked from three
 * places is three nodes. Thresholding per node (the old implementation)
 * misses a method that burns 90% of total self-time spread 30/30/30 across
 * three call sites: no single node ever crosses 50%, so the tool reported no
 * dominant method while one method ate the whole profile.
 * `aggregateByMethod` already sums self-time by
 * (functionName, objectType, objectId) for the breakdown table (see
 * analyzer.ts) — this detector now thresholds on that same aggregate, so the
 * detector and the breakdown table agree on what a "method" is.
 *
 * Severity: critical.
 */
export const detectSingleMethodDominance: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	const patterns: DetectedPattern[] = [];

	// Per-method call sites, needed to disclose the call-site count and to
	// find the representative (highest self-time) node for the evidence
	// string. The aggregate's own selfTime/selfTimePercent — not the
	// representative node's — drive impact/evidence: using the
	// representative's own (smaller) numbers would silently drop the other
	// call sites and under-report the true aggregate.
	const callSitesByMethod = new Map<string, ProcessedNode[]>();
	for (const node of profile.allNodes) {
		if (isIdleNode(node)) continue;
		const key = methodGroupKey(node);
		let sites = callSitesByMethod.get(key);
		if (!sites) {
			sites = [];
			callSitesByMethod.set(key, sites);
		}
		sites.push(node);
	}

	for (const method of aggregateByMethod(profile)) {
		if (method.selfTimePercent <= 50) continue;

		const key = `${method.functionName}_${method.objectType}_${method.objectId}`;
		const callSites = callSitesByMethod.get(key);
		if (!callSites || callSites.length === 0) {
			// Should be unreachable: methodGroupKey() and aggregateByMethod's key
			// (src/core/aggregator.ts) are built from the same fields with the
			// same idle-node exclusion, so every method aggregateByMethod
			// produces must have a matching entry in callSitesByMethod. If this
			// throws, the two key functions have drifted apart — fail loudly
			// instead of silently dropping the finding (see the "MUST match"
			// comment above methodGroupKey).
			throw new Error(
				`single-method-dominance: no call sites found for method key "${key}" ` +
					"(methodGroupKey and aggregateByMethod's key must agree — they have drifted apart)",
			);
		}

		const representative = callSites.reduce((max, node) =>
			node.selfTime > max.selfTime ? node : max,
		);
		const sites = callSiteWord(callSites.length);

		patterns.push({
			id: "single-method-dominance",
			severity: "critical",
			title: `${method.functionName} dominates profile`,
			description: `${formatMethodBreakdownRef(method)} accounts for ${method.selfTimePercent.toFixed(1)}% of total self-time, aggregated across ${callSites.length} ${sites}.`,
			impact: method.selfTime,
			involvedMethods: [formatMethodBreakdownRef(method)],
			evidence: `selfTimePercent = ${method.selfTimePercent.toFixed(1)}% aggregated across ${callSites.length} ${sites} (largest single call site: ${representative.selfTimePercent.toFixed(1)}%) (threshold: 50%)`,
			suggestion:
				"Investigate this method for tight computation loops or excessive calls. Consider caching results or reducing call frequency.",
		});
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
				title: `${displayFunctionName(node)} has disproportionate hit count`,
				description: `${displayMethodRef(node)} has ${node.hitCount} hits vs parent ${displayMethodRef(node.parent)} with ${node.parent.hitCount} hits (ratio ${(node.hitCount / node.parent.hitCount).toFixed(1)}x).`,
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
		const key = methodGroupKey(node);
		methodTotalCounts.set(key, (methodTotalCounts.get(key) ?? 0) + 1);
	}

	for (const node of profile.allNodes) {
		if (isIdleNode(node) || !node.parent) continue;
		const childKey = methodGroupKey(node);
		const parentKey = methodGroupKey(node.parent);
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
			const parentKey = methodGroupKey(edge.parent);
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
 * Detect parents with 50+ children sharing the same method identity
 * (functionName+objectType+objectId — see methodGroupKey).
 * Severity: critical.
 */
export const detectRepeatedSiblings: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	const patterns: DetectedPattern[] = [];

	for (const node of profile.allNodes) {
		if (isIdleNode(node)) continue;
		if (node.children.length < 50) continue;

		// Group children by method identity (functionName+objectType+objectId)
		const groups = new Map<string, ProcessedNode[]>();
		for (const child of node.children) {
			const key = methodGroupKey(child);
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
						? `${group.length} sibling invocations with same functionName+objectType+objectId (exact invocation count, threshold: 50)`
						: `${group.length} sibling calls with same functionName+objectType+objectId (threshold: 50)`,
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
 * that collectively consume >10% of total selfTime, aggregated across call sites.
 *
 * Has the identical per-node blindness detectSingleMethodDominance had: the
 * same subscriber invoked from several call sites used to be listed (and
 * counted) once per call site instead of once per method. Grouped here by
 * method before the involvedMethods list and counts are built, the same fix
 * applied to detectSingleMethodDominance.
 *
 * Aggregation is done inline rather than via aggregateByMethod: that helper
 * sorts its result by selfTime descending, but involvedMethods[0] is the
 * fingerprint anchor (see wire.ts ANCHOR POLICY) and must stay a
 * deterministic, tree-traversal-ordered representative — re-sorting by heat
 * would split identities whenever two subscribers traded places. The Map
 * below is built by iterating profile.allNodes in order, so insertion order
 * (and therefore Array.from(...values())) is first-appearance order.
 *
 * Severity: warning.
 */
export const detectEventSubscriberHotspot: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	const eventPrefixes = ["OnBefore", "OnAfter", "HandleOn"];
	const isEventName = (name: string) =>
		eventPrefixes.some((prefix) => name.startsWith(prefix));

	interface EventMethodAggregate {
		functionName: string;
		objectType: string;
		objectId: number;
		selfTime: number;
		selfTimePercent: number;
		callSiteCount: number;
	}
	const methods = new Map<string, EventMethodAggregate>();

	for (const node of profile.allNodes) {
		if (isIdleNode(node) || !isEventName(node.callFrame.functionName)) continue;
		const key = methodGroupKey(node);
		let entry = methods.get(key);
		if (!entry) {
			const { objectType, objectId } = node.applicationDefinition;
			entry = {
				functionName: node.callFrame.functionName,
				objectType,
				objectId,
				selfTime: 0,
				selfTimePercent: 0,
				callSiteCount: 0,
			};
			methods.set(key, entry);
		}
		entry.selfTime += node.selfTime;
		entry.selfTimePercent += node.selfTimePercent;
		entry.callSiteCount += 1;
	}

	if (methods.size === 0) return [];

	const aggregated = Array.from(methods.values());
	const totalSelfTimePercent = aggregated.reduce(
		(sum, m) => sum + m.selfTimePercent,
		0,
	);

	if (totalSelfTimePercent <= 10) return [];

	const totalImpact = aggregated.reduce((sum, m) => sum + m.selfTime, 0);
	const totalCallSites = aggregated.reduce(
		(sum, m) => sum + m.callSiteCount,
		0,
	);
	const involvedMethods = aggregated.map(formatMethodBreakdownRef);

	return [
		{
			id: "event-subscriber-hotspot",
			severity: "warning",
			title: `Event subscribers consume ${totalSelfTimePercent.toFixed(1)}% of self-time`,
			description: `${aggregated.length} event subscriber ${methodWord(aggregated.length)} (OnBefore/OnAfter/HandleOn), aggregated across ${totalCallSites} ${callSiteWord(totalCallSites)}, collectively account for ${totalSelfTimePercent.toFixed(1)}% of total self-time.`,
			impact: totalImpact,
			involvedMethods,
			evidence: `Combined selfTimePercent = ${totalSelfTimePercent.toFixed(1)}% across ${aggregated.length} ${methodWord(aggregated.length)}, aggregated across ${totalCallSites} ${callSiteWord(totalCallSites)} (threshold: 10%)`,
			suggestion:
				"This event subscriber is consuming significant time. Review whether it needs to run for every event, or if it can be filtered or optimized.",
		},
	];
};

/**
 * Detect recursive calls: a method that appears as its own ancestor.
 * Severity: warning.
 */
/**
 * Whether `node` genuinely participates in a recursive chain for `key` — it
 * has an ancestor OR a descendant that is the same method. A node that merely
 * shares the method name with a recursion happening elsewhere in the tree is
 * an ordinary call and must not be counted as part of it.
 */
function isInRecursiveChain(node: ProcessedNode, key: string): boolean {
	for (let a = node.parent; a; a = a.parent) {
		if (methodGroupKey(a) === key) return true;
	}
	const stack = [...node.children];
	while (stack.length > 0) {
		const child = stack.pop()!;
		if (methodGroupKey(child) === key) return true;
		stack.push(...child.children);
	}
	return false;
}

export const detectRecursion: PatternDetector = (
	profile: ProcessedProfile,
): DetectedPattern[] => {
	const reported = new Set<string>();
	const patterns: DetectedPattern[] = [];

	for (const node of profile.allNodes) {
		if (isIdleNode(node)) continue;
		const key = methodGroupKey(node);
		if (reported.has(key)) continue;

		// Walk up ancestors to check for same method
		let ancestor = node.parent;
		let depth = 0;
		while (ancestor) {
			if (methodGroupKey(ancestor) === key) {
				reported.add(key);

				// Only nodes that are THEMSELVES part of a recursive chain —
				// i.e. that have a same-method ancestor or descendant. Counting
				// every occurrence of the method anywhere in the tree inflated
				// both the number and the impact, while the text claimed all of
				// them were "in the call tree as a recursive chain": an ordinary
				// call from an unrelated branch is not recursion. Measured on
				// captured BC profiles, 5 of 38 findings overstated their count
				// this way.
				const allInstances = profile.allNodes.filter(
					(n) => methodGroupKey(n) === key && isInRecursiveChain(n, key),
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

	// Report a root that has at least one event subscriber beneath it.
	for (const [_, chain] of chains) {
		// `chain.chain[0]` is the ROOT itself — it is not one of the subscribers
		// it triggers, and counting it inflated every number the finding
		// reported by one ("OnAfterLogin (11 subscribers)" for 10).
		const members = chain.chain.slice(1);
		if (members.length < 1) continue;
		// Members are grouped by NEAREST event ancestor, so they form a TREE
		// under the root, not a chain: in a captured BC profile their depth
		// offsets were [6,9,6,1,1,1,1,1,1,6] — six siblings directly beneath,
		// plus deeper branches. Saying "a chain of N" and advising "reduce the
		// chain depth" described a shape the profile does not have, and so the
		// wrong fix. Report the fan-out and the real nesting depth separately.
		const depths = members.map((n) => n.depth - chain.root.depth);
		const maxDepth = Math.max(...depths);
		const direct = depths.filter((d) => d === 1).length;
		const methods = chain.chain.map((n) => formatMethodRef(n));
		patterns.push({
			id: "event-chain",
			severity: "warning",
			title: `Event chain from ${chain.root.callFrame.functionName} (${members.length} subscribers)`,
			description: `Event subscriber ${formatMethodRef(chain.root)} runs ${members.length} further event subscriber(s) beneath it — ${direct} directly beneath it, nested at most ${maxDepth} level(s) deep. Every one of them runs on each publish.`,
			impact: chain.totalTime,
			involvedMethods: methods,
			evidence: `${members.length} event subscriber(s) beneath ${chain.root.callFrame.functionName}, ${direct} directly beneath it, ${maxDepth} level(s) deep`,
			suggestion:
				"Review whether all of these subscribers are necessary. Fan-out is reduced by consolidating handlers on the same event; depth is reduced by not raising further events from inside a subscriber.",
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

	return sortPatterns(patterns);
}
