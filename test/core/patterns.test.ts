import { describe, expect, test } from "bun:test";
import { parseProfile } from "../../src/core/parser.js";
import {
	detectDeepCallStack,
	detectEventChains,
	detectEventSubscriberHotspot,
	detectHighHitCount,
	detectRecursion,
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
		// 3 call sites x 30% self-time = 90% of the profile in one method.
		// Per-node thresholding sees three 30% nodes and reports nothing.
		const profile = makeProfileWith([
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
				selfTimePercent: 30,
			},
			{
				objectType: "Codeunit",
				objectId: 50000,
				functionName: "Post",
				selfTimePercent: 30,
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
