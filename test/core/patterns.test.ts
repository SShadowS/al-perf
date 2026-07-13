import { describe, expect, test } from "bun:test";
import { parseProfile } from "../../src/core/parser.js";
import {
	detectDeepCallStack,
	detectEventChains,
	detectEventSubscriberHotspot,
	detectHighHitCount,
	detectRecursion,
	detectRepeatedSiblings,
	detectSingleMethodDominance,
	runDetectors,
} from "../../src/core/patterns.js";
import { processProfile } from "../../src/core/processor.js";
import type {
	ProcessedNode,
	ProcessedProfile,
} from "../../src/types/processed.js";

const FIXTURES = "test/fixtures";

interface MethodSpec {
	objectType: string;
	objectId: number;
	functionName: string;
	selfTimePercent: number;
}

/**
 * Build a minimal synthetic ProcessedProfile from a flat list of method
 * specs — one ProcessedNode (one call site) per spec. selfTimePercent is a
 * literal percent of a fixed 100-unit profile (activeSelfTime is pinned to
 * 100), so several specs sharing the same functionName/objectType/objectId
 * model the same method split across several call sites, each with its own
 * selfTime.
 */
function makeProfileWith(specs: MethodSpec[]): ProcessedProfile {
	const PROFILE_TOTAL = 100;
	const allNodes: ProcessedNode[] = specs.map((spec, index) => {
		const selfTime = (spec.selfTimePercent / 100) * PROFILE_TOTAL;
		return {
			id: index + 1,
			callFrame: {
				functionName: spec.functionName,
				scriptId: `${spec.objectType}_${spec.objectId}`,
				url: "",
				lineNumber: 1,
				columnNumber: 0,
			},
			applicationDefinition: {
				objectType: spec.objectType,
				objectName: `Test${spec.objectType}`,
				objectId: spec.objectId,
			},
			hitCount: 1,
			children: [],
			depth: 0,
			selfTime,
			totalTime: selfTime,
			selfTimePercent: spec.selfTimePercent,
			totalTimePercent: spec.selfTimePercent,
		};
	});

	return {
		type: "sampling",
		roots: allNodes,
		allNodes,
		nodeMap: new Map(allNodes.map((n) => [n.id, n])),
		totalDuration: PROFILE_TOTAL,
		totalSelfTime: allNodes.reduce((sum, n) => sum + n.selfTime, 0),
		activeSelfTime: PROFILE_TOTAL,
		idleSelfTime: 0,
		maxDepth: 0,
		nodeCount: allNodes.length,
		startTime: 0,
		endTime: PROFILE_TOTAL,
	};
}

interface MethodIdentitySpec {
	objectType: string;
	objectId: number;
	functionName: string;
}

function makeIdentityNode(id: number, spec: MethodIdentitySpec): ProcessedNode {
	return {
		id,
		callFrame: {
			functionName: spec.functionName,
			scriptId: `${spec.objectType}_${spec.objectId}`,
			url: "",
			lineNumber: 1,
			columnNumber: 0,
		},
		applicationDefinition: {
			objectType: spec.objectType,
			objectName: `Test${spec.objectType}`,
			objectId: spec.objectId,
		},
		hitCount: 1,
		children: [],
		depth: 0,
		selfTime: 1,
		totalTime: 1,
		selfTimePercent: 1,
		totalTimePercent: 1,
	};
}

/**
 * Build a synthetic ProcessedProfile with one parent node and childSpecs.length
 * children, all direct siblings under that parent. makeProfileWith produces
 * flat, unrelated roots with no parent/children relationship, which cannot
 * exercise detectRepeatedSiblings (it groups a node's own children).
 */
function makeSiblingProfile(
	parentSpec: MethodIdentitySpec,
	childSpecs: MethodIdentitySpec[],
): ProcessedProfile {
	let nextId = 1;
	const parent = makeIdentityNode(nextId++, parentSpec);
	const children = childSpecs.map((spec) => makeIdentityNode(nextId++, spec));
	for (const child of children) {
		child.parent = parent;
		child.depth = 1;
	}
	parent.children = children;

	const allNodes = [parent, ...children];
	return {
		type: "sampling",
		roots: [parent],
		allNodes,
		nodeMap: new Map(allNodes.map((n) => [n.id, n])),
		totalDuration: allNodes.length,
		totalSelfTime: allNodes.length,
		activeSelfTime: allNodes.length,
		idleSelfTime: 0,
		maxDepth: 1,
		nodeCount: allNodes.length,
		startTime: 0,
		endTime: allNodes.length,
	};
}

/**
 * Build a synthetic ProcessedProfile from a linear ancestor chain: specs[0] is
 * the root, specs[1] is its child, specs[2] is specs[1]'s child, and so on.
 * Needed to exercise detectRecursion's ancestor walk, which makeProfileWith's
 * flat unrelated roots cannot model.
 */
function makeChainProfile(specs: MethodIdentitySpec[]): ProcessedProfile {
	const nodes = specs.map((spec, index) => makeIdentityNode(index + 1, spec));
	for (let i = 1; i < nodes.length; i++) {
		nodes[i].parent = nodes[i - 1];
		nodes[i].depth = i;
		nodes[i - 1].children = [nodes[i]];
	}

	return {
		type: "sampling",
		roots: [nodes[0]],
		allNodes: nodes,
		nodeMap: new Map(nodes.map((n) => [n.id, n])),
		totalDuration: nodes.length,
		totalSelfTime: nodes.length,
		activeSelfTime: nodes.length,
		idleSelfTime: 0,
		maxDepth: Math.max(0, nodes.length - 1),
		nodeCount: nodes.length,
		startTime: 0,
		endTime: nodes.length,
	};
}

describe("detectSingleMethodDominance", () => {
	test("flags method with >50% of total selfTime", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const patterns = detectSingleMethodDominance(processed);

		// ProcessLine has 20/35 = 57.1% of total selfTime
		expect(patterns).toHaveLength(1);
		expect(patterns[0].id).toBe("single-method-dominance");
		expect(patterns[0].severity).toBe("critical");
		expect(patterns[0].involvedMethods[0]).toContain("ProcessLine");
		expect(patterns[0].suggestion).toBeDefined();
		expect(typeof patterns[0].suggestion).toBe("string");
	});
});

describe("single-method-dominance — aggregation", () => {
	test("flags a method that dominates via several call sites, not one", () => {
		// 3 call sites at 45/30/15% self-time = 90% of the profile in one
		// method, with no single call site above the 50% threshold.
		// Per-node thresholding sees three sub-50% nodes and reports nothing.
		// The sites are deliberately asymmetric (not 30/30/30) so the
		// "representative" (highest self-time) call site is observable: if the
		// representative-selection reduce were inverted to pick the LOWEST
		// self-time node, or the evidence's "largest single call site" clause
		// were deleted, this test must fail.
		const profile = makeProfileWith([
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "Post",
				selfTimePercent: 45,
			},
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "Post",
				selfTimePercent: 30,
			},
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "Post",
				selfTimePercent: 15,
			},
		]);

		const patterns = detectSingleMethodDominance(profile);
		const dominance = patterns.find((p) => p.id === "single-method-dominance");

		expect(dominance).toBeDefined();
		expect(dominance!.involvedMethods).toEqual(["Post (Codeunit 50000)"]);
		expect(dominance!.impact).toBe(90);
		// The evidence must state the aggregation — a user who greps the
		// profile for a single 90% frame must not conclude the tool is lying.
		expect(dominance!.evidence).toContain("aggregated across 3 call sites");
		// The evidence must name the true largest call site (45%), not the
		// smallest (15%) and not omit the clause entirely.
		expect(dominance!.evidence).toContain("largest single call site: 45.0%");
	});

	test("does not flag three DIFFERENT methods at 30% each", () => {
		// The guard against over-correcting: aggregation must key on the
		// method, not collapse everything.
		const profile = makeProfileWith([
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "A",
				selfTimePercent: 30,
			},
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "B",
				selfTimePercent: 30,
			},
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "C",
				selfTimePercent: 30,
			},
		]);
		expect(detectSingleMethodDominance(profile)).toHaveLength(0);
	});
});

describe("detectEventSubscriberHotspot — aggregation", () => {
	test("counts a subscriber once, not once per call site", () => {
		// Same event subscriber invoked from 3 call sites at 4% self-time each
		// = 12% combined, above the 10% threshold. Previously each call site
		// was listed separately in involvedMethods (3 duplicate entries) and
		// counted as 3 separate "methods" in the description.
		const profile = makeProfileWith([
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "OnAfterPost",
				selfTimePercent: 4,
			},
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "OnAfterPost",
				selfTimePercent: 4,
			},
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "OnAfterPost",
				selfTimePercent: 4,
			},
		]);

		const patterns = detectEventSubscriberHotspot(profile);

		expect(patterns).toHaveLength(1);
		expect(patterns[0].involvedMethods).toEqual([
			"OnAfterPost (Codeunit 50000)",
		]);
		expect(patterns[0].evidence).toContain("aggregated across 3 call sites");
	});

	test("does not merge different subscriber methods", () => {
		// The guard against over-correcting: aggregation must key on the
		// method, not collapse every subscriber into one entry.
		const profile = makeProfileWith([
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "OnBeforeA",
				selfTimePercent: 4,
			},
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "OnAfterB",
				selfTimePercent: 4,
			},
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "HandleOnC",
				selfTimePercent: 4,
			},
		]);

		const patterns = detectEventSubscriberHotspot(profile);

		expect(patterns).toHaveLength(1);
		expect(patterns[0].involvedMethods).toHaveLength(3);
	});

	test("keeps involvedMethods in first-appearance order, not selfTime order", () => {
		// involvedMethods[0] is the fingerprint anchor (see wire.ts ANCHOR
		// POLICY) and must stay tree-traversal-ordered. If the hottest method
		// were sorted to the front instead, the anchor would change whenever
		// two subscribers traded places in heat — splitting finding identity
		// across runs. OnAfterBig has the largest selfTime but appears second;
		// it must NOT become involvedMethods[0].
		const profile = makeProfileWith([
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "OnBeforeSmall",
				selfTimePercent: 2,
			},
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "OnAfterBig",
				selfTimePercent: 6,
			},
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "HandleOnMedium",
				selfTimePercent: 4,
			},
		]);

		const patterns = detectEventSubscriberHotspot(profile);

		expect(patterns).toHaveLength(1);
		expect(patterns[0].involvedMethods).toEqual([
			"OnBeforeSmall (Codeunit 50000)",
			"OnAfterBig (Codeunit 50000)",
			"HandleOnMedium (Codeunit 50000)",
		]);
	});
});

describe("detectHighHitCount", () => {
	test("flags child with hitCount much higher than parent", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const patterns = detectHighHitCount(processed);

		// Node 2 (hitCount=20) is child of Node 1 (hitCount=5): ratio 4x
		// Threshold is 10x, so this should NOT flag
		expect(patterns).toHaveLength(0);
	});
});

describe("detectDeepCallStack", () => {
	test("does not flag shallow profiles", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const patterns = detectDeepCallStack(processed);

		expect(patterns).toHaveLength(0);
	});
});

describe("detectRecursion", () => {
	test("detects recursive calls", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const patterns = detectRecursion(processed);

		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].id).toBe("recursive-call");
		expect(patterns[0].severity).toBe("warning");
		expect(patterns[0].involvedMethods[0]).toContain("ProcessRecursive");
	});

	test("does not flag non-recursive profiles", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const patterns = detectRecursion(processed);

		expect(patterns).toHaveLength(0);
	});
});

describe("method identity", () => {
	test("does not merge a codeunit and a table that share an object id (repeated-siblings)", () => {
		// Build a profile with codeunit 50000 "Run" and table 50000 "Run" as
		// siblings, each below the repeated-siblings threshold on its own but
		// above it if wrongly merged.
		const codeunitChildren: MethodIdentitySpec[] = Array.from(
			{ length: 30 },
			() => ({ objectType: "Codeunit", objectId: 50000, functionName: "Run" }),
		);
		const tableChildren: MethodIdentitySpec[] = Array.from(
			{ length: 30 },
			() => ({ objectType: "Table", objectId: 50000, functionName: "Run" }),
		);
		const profile = makeSiblingProfile(
			{ objectType: "Codeunit", objectId: 1, functionName: "Caller" },
			[...codeunitChildren, ...tableChildren],
		);

		const patterns = runDetectors(profile);

		// If the key omitted objectType these would merge to 60 and trip the
		// threshold. They are different methods and must not.
		expect(patterns.find((p) => p.id === "repeated-siblings")).toBeUndefined();
	});

	test("still flags 50+ genuinely identical siblings (regression guard)", () => {
		const children: MethodIdentitySpec[] = Array.from({ length: 50 }, () => ({
			objectType: "Codeunit",
			objectId: 50000,
			functionName: "Run",
		}));
		const profile = makeSiblingProfile(
			{ objectType: "Codeunit", objectId: 1, functionName: "Caller" },
			children,
		);

		const patterns = detectRepeatedSiblings(profile);

		expect(patterns).toHaveLength(1);
		expect(patterns[0].id).toBe("repeated-siblings");
	});

	test("does not report false recursion between a codeunit and table sharing an object id", () => {
		// Chain: Codeunit 50000 "Run" -> Codeunit 1 "Wrapper" -> Table 50000
		// "Run". Root and leaf share functionName+objectId but differ in
		// objectType. If the ancestor-walk key omitted objectType, this would
		// be reported as recursion between two unrelated objects.
		const profile = makeChainProfile([
			{ objectType: "Codeunit", objectId: 50000, functionName: "Run" },
			{ objectType: "Codeunit", objectId: 1, functionName: "Wrapper" },
			{ objectType: "Table", objectId: 50000, functionName: "Run" },
		]);

		const patterns = detectRecursion(profile);

		expect(patterns).toHaveLength(0);
	});

	test("still detects genuine recursion when objectType and objectId match (regression guard)", () => {
		const profile = makeChainProfile([
			{ objectType: "Codeunit", objectId: 50000, functionName: "Run" },
			{ objectType: "Codeunit", objectId: 1, functionName: "Wrapper" },
			{ objectType: "Codeunit", objectId: 50000, functionName: "Run" },
		]);

		const patterns = detectRecursion(profile);

		expect(patterns).toHaveLength(1);
		expect(patterns[0].id).toBe("recursive-call");
	});
});

describe("detectEventChains", () => {
	test("does not flag profiles without event chains", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const patterns = detectEventChains(processed);
		expect(patterns).toHaveLength(0);
	});

	test("detects event chains in profile with nested event subscribers", async () => {
		const parsed = await parseProfile(`${FIXTURES}/event-chain.alcpuprofile`);
		const processed = processProfile(parsed);
		const patterns = detectEventChains(processed);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].id).toBe("event-chain");
		expect(patterns[0].severity).toBe("warning");
		expect(patterns[0].involvedMethods.length).toBeGreaterThanOrEqual(2);
	});
});

describe("runDetectors", () => {
	test("returns patterns sorted by impact descending", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const patterns = runDetectors(processed);

		for (let i = 1; i < patterns.length; i++) {
			expect(patterns[i - 1].impact).toBeGreaterThanOrEqual(patterns[i].impact);
		}
	});

	test("does not produce false positives from IdleTime", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const patterns = runDetectors(processed);

		// IdleTime dominance is gone — only legitimate patterns remain
		const idlePatterns = patterns.filter((p) =>
			p.involvedMethods.some((m) => m.includes("IdleTime")),
		);
		expect(idlePatterns.length).toBe(0);

		// All returned patterns should have a suggestion
		for (const pattern of patterns) {
			expect(pattern.suggestion).toBeDefined();
			expect(typeof pattern.suggestion).toBe("string");
		}
	});
});
