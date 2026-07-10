/**
 * wire.test.ts — Unit tests for src/lifecycle/wire.ts (fingerprint wiring).
 *
 * Covers:
 *  - buildMethodLabelMap: label round-trip against the detector label format
 *  - resolvePatternAnchor: anchor policy (involvedMethods[0]) + the full
 *    resolution ladder (resolved / parseable-unresolved / unparseable / empty)
 *  - attribution-aware identity (stable when matched, fallback otherwise,
 *    ambiguous NEVER stable)
 *  - fingerprintPatterns: canonical string form, determinism,
 *    fallback-vs-attributed divergence, member-trigger normalization
 */

import { describe, expect, it } from "bun:test";
import {
	computePatternFingerprint,
	formatFingerprint,
} from "../../src/lifecycle/fingerprint.js";
import {
	buildMethodLabelMap,
	fingerprintPatterns,
	resolvePatternAnchor,
} from "../../src/lifecycle/wire.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { SemanticAttribution } from "../../src/types/fused.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

const APP_ID = "437dbf0e-84ff-417a-965d-ed2bb9650972";
const SID = "437dbf0e-84ff-417a-965d-ed2bb9650972:Codeunit:50100#a1b2c3d4";

function makeMethod(
	functionName: string,
	objectType: string,
	objectId: number,
	opts?: Partial<MethodBreakdown>,
): MethodBreakdown {
	return {
		functionName,
		objectType,
		objectName: "TestObject",
		objectId,
		appName: "TestApp",
		selfTime: 1000,
		selfTimePercent: 10,
		totalTime: 2000,
		totalTimePercent: 20,
		hitCount: 5,
		calledBy: [],
		calls: [],
		costPerHit: 200,
		efficiencyScore: 0.5,
		...opts,
	};
}

function makePattern(id: string, involvedMethods: string[]): DetectedPattern {
	return {
		id,
		severity: "warning",
		title: "t",
		description: "d",
		impact: 100,
		involvedMethods,
		evidence: "e",
	};
}

describe("buildMethodLabelMap", () => {
	it('indexes methods by the detector label format "<fn> (<type> <id>)"', () => {
		const m = makeMethod("ProcessRecords", "Codeunit", 50100);
		const map = buildMethodLabelMap([m]);
		expect(map.get("ProcessRecords (Codeunit 50100)")).toBe(m);
	});
});

describe("resolvePatternAnchor", () => {
	const methods = [
		makeMethod("Child", "Codeunit", 50100, { appId: APP_ID }),
		makeMethod("Parent", "Codeunit", 50200, { appId: APP_ID }),
	];
	const byLabel = buildMethodLabelMap(methods);

	it("anchors on involvedMethods[0] — never a later entry", () => {
		const anchor = resolvePatternAnchor(
			makePattern("high-hit-count", [
				"Child (Codeunit 50100)",
				"Parent (Codeunit 50200)",
			]),
			byLabel,
		);
		expect(anchor.identity).toEqual({
			kind: "fallback",
			appId: "437dbf0e84ff417a965ded2bb9650972",
			canonicalObjectType: "Codeunit",
			objectNumber: 50100,
			normalizedRoutineName: "child",
		});
	});

	it("a resolved anchor carries the method's declaring appId", () => {
		const anchor = resolvePatternAnchor(
			makePattern("single-method-dominance", ["Child (Codeunit 50100)"]),
			byLabel,
		);
		expect(anchor.appId).toBe(APP_ID);
	});

	it("a matched attribution upgrades the anchor to a stable identity", () => {
		const attributions = new Map<string, SemanticAttribution>([
			[
				"Child_Codeunit_50100",
				{
					status: "matched",
					findings: [],
					attributionConfidence: "exact",
					stableRoutineId: SID,
				},
			],
		]);
		const anchor = resolvePatternAnchor(
			makePattern("single-method-dominance", ["Child (Codeunit 50100)"]),
			byLabel,
			attributions,
		);
		expect(anchor.identity).toEqual({ kind: "stable", stableRoutineId: SID });
	});

	it("an ambiguous attribution stays on the fallback key (never trust a union)", () => {
		const attributions = new Map<string, SemanticAttribution>([
			[
				"Child_Codeunit_50100",
				{
					status: "ambiguous",
					findings: [],
					attributionConfidence: "ambiguous",
					stableRoutineId: [SID, `${SID}ff`],
				},
			],
		]);
		const anchor = resolvePatternAnchor(
			makePattern("single-method-dominance", ["Child (Codeunit 50100)"]),
			byLabel,
			attributions,
		);
		expect(anchor.identity.kind).toBe("fallback");
	});

	it('a parseable label absent from the method set falls back to the parsed identity with appId ""', () => {
		const anchor = resolvePatternAnchor(
			makePattern("recursive-call", ["Ghost (Table 18)"]),
			byLabel,
		);
		expect(anchor.appId).toBe("");
		expect(anchor.identity).toEqual({
			kind: "fallback",
			appId: "",
			canonicalObjectType: "Table",
			objectNumber: 18,
			normalizedRoutineName: "ghost",
		});
	});

	it('a member-trigger label parses greedily: only the LAST " (" starts the object suffix', () => {
		const anchor = resolvePatternAnchor(
			makePattern("recursive-call", [
				"Sell-to Customer No. - OnValidate (Table 36)",
			]),
			byLabel,
		);
		expect(anchor.identity).toEqual({
			kind: "fallback",
			appId: "",
			canonicalObjectType: "Table",
			objectNumber: 36,
			normalizedRoutineName: "onvalidate",
		});
	});

	it("an unparseable label yields a deterministic unkeyable-style fallback", () => {
		const a = resolvePatternAnchor(makePattern("x", ["not a label"]), byLabel);
		const b = resolvePatternAnchor(makePattern("x", ["not a label"]), byLabel);
		expect(a).toEqual(b);
		expect(a.identity).toEqual({
			kind: "fallback",
			appId: "",
			canonicalObjectType: "",
			objectNumber: 0,
			normalizedRoutineName: "not a label",
		});
	});

	it("empty involvedMethods yields a deterministic empty-key fallback", () => {
		const anchor = resolvePatternAnchor(
			makePattern("deep-call-stack", []),
			byLabel,
		);
		expect(anchor.identity).toEqual({
			kind: "fallback",
			appId: "",
			canonicalObjectType: "",
			objectNumber: 0,
			normalizedRoutineName: "",
		});
	});
});

describe("fingerprintPatterns", () => {
	const methods = [
		makeMethod("ProcessRecords", "Codeunit", 50100, { appId: APP_ID }),
	];

	it("stamps the canonical string form pattern:<16-hex> on every pattern", () => {
		const patterns = [
			makePattern("calcfields-in-loop", ["ProcessRecords (Codeunit 50100)"]),
			makePattern("modify-in-loop", ["ProcessRecords (Codeunit 50100)"]),
		];
		fingerprintPatterns(patterns, methods);
		for (const p of patterns) {
			expect(p.fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
		}
		expect(patterns[0].fingerprint).not.toBe(patterns[1].fingerprint);
	});

	it("is deterministic across runs", () => {
		const a = makePattern("calcfields-in-loop", [
			"ProcessRecords (Codeunit 50100)",
		]);
		const b = makePattern("calcfields-in-loop", [
			"ProcessRecords (Codeunit 50100)",
		]);
		fingerprintPatterns([a], methods);
		fingerprintPatterns([b], methods);
		expect(a.fingerprint).toBe(b.fingerprint);
	});

	it("matches computePatternFingerprint over the resolved anchor (no hidden inputs)", () => {
		const p = makePattern("calcfields-in-loop", [
			"ProcessRecords (Codeunit 50100)",
		]);
		fingerprintPatterns([p], methods);
		const expected = formatFingerprint(
			computePatternFingerprint(
				{ patternId: "calcfields-in-loop" },
				{
					kind: "fallback",
					appId: "437dbf0e84ff417a965ded2bb9650972",
					canonicalObjectType: "Codeunit",
					objectNumber: 50100,
					normalizedRoutineName: "processrecords",
				},
				APP_ID,
			),
		);
		expect(p.fingerprint).toBe(expected);
	});

	it("fallback vs attributed identities diverge for the same pattern (the identity-upgrade seam)", () => {
		const fallbackP = makePattern("calcfields-in-loop", [
			"ProcessRecords (Codeunit 50100)",
		]);
		const attributedP = makePattern("calcfields-in-loop", [
			"ProcessRecords (Codeunit 50100)",
		]);
		fingerprintPatterns([fallbackP], methods);
		fingerprintPatterns(
			[attributedP],
			methods,
			new Map<string, SemanticAttribution>([
				[
					"ProcessRecords_Codeunit_50100",
					{
						status: "matched",
						findings: [],
						attributionConfidence: "exact",
						stableRoutineId: SID,
					},
				],
			]),
		);
		expect(fallbackP.fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
		expect(attributedP.fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
		expect(fallbackP.fingerprint).not.toBe(attributedP.fingerprint);
	});
});
