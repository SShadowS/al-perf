import { describe, expect, test } from "bun:test";
import {
	annotateStaticCause,
	PROFILE_ONLY_PATTERN_IDS,
} from "../../src/core/annotate-cause.js";
import { buildSourceIndex } from "../../src/source/indexer.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

const INDEX = await buildSourceIndex("test/fixtures/source");

function method(
	functionName: string,
	objectType: string,
	objectId: number,
): MethodBreakdown {
	return {
		functionName,
		objectType,
		objectId,
		objectName: "Fixture",
		appName: "Fixture App",
		selfTime: 1000,
		totalTime: 2000,
		selfTimePercent: 10,
		totalTimePercent: 20,
		hitCount: 1,
		callSites: 1,
		calledBy: [],
	} as unknown as MethodBreakdown;
}

function pattern(
	id: string,
	involvedMethods: string[],
	suggestion = "BASE.",
): DetectedPattern {
	return {
		id,
		severity: "warning",
		title: `${id} title`,
		description: "d",
		impact: 1000,
		involvedMethods,
		evidence: "e",
		suggestion,
	};
}

const PROCESS = "ProcessRecords (Codeunit 50100)";
const SIMPLE = "SimpleMethod (Codeunit 50100)";

describe("annotateStaticCause", () => {
	test("names a source-correlated sibling on the same routine", () => {
		const p = [
			pattern("single-method-dominance", [PROCESS]),
			pattern("modify-in-loop", [PROCESS]),
		];
		annotateStaticCause(
			p,
			[method("ProcessRecords", "Codeunit", 50100)],
			INDEX,
		);
		expect(p[0].suggestion).toContain("modify-in-loop");
		expect(p[0].suggestion).toStartWith("BASE.");
	});

	test("claims no loop findings only in scoped language", () => {
		// The unscoped phrasing would be false whenever the routine's real
		// problem is a source-ONLY pattern -- unfiltered-findset,
		// dangerous-call-in-loop -- which analyzeProfile never runs.
		const p = [pattern("single-method-dominance", [SIMPLE])];
		annotateStaticCause(p, [method("SimpleMethod", "Codeunit", 50100)], INDEX);
		expect(p[0].suggestion).toContain("No loop or SetLoadFields findings");
		expect(p[0].suggestion).not.toContain("No database anti-patterns");
	});

	test("says nothing when the routine does not resolve exactly", () => {
		const anchor = "ProcessRecords (Codeunit 99999)";
		const p = [pattern("single-method-dominance", [anchor])];
		annotateStaticCause(
			p,
			[method("ProcessRecords", "Codeunit", 99999)],
			INDEX,
		);
		expect(p[0].suggestion).toBe("BASE.");
	});

	test("says nothing about a multi-routine finding", () => {
		const p = [pattern("deep-call-stack", [PROCESS, SIMPLE])];
		annotateStaticCause(
			p,
			[
				method("ProcessRecords", "Codeunit", 50100),
				method("SimpleMethod", "Codeunit", 50100),
			],
			INDEX,
		);
		expect(p[0].suggestion).toBe("BASE.");
	});

	test("still names siblings for a multi-routine finding", () => {
		const p = [
			pattern("deep-call-stack", [PROCESS, SIMPLE]),
			pattern("modify-in-loop", [PROCESS]),
		];
		annotateStaticCause(
			p,
			[method("ProcessRecords", "Codeunit", 50100)],
			INDEX,
		);
		expect(p[0].suggestion).toContain("modify-in-loop");
	});

	test("never annotates a source-correlated pattern", () => {
		const p = [
			pattern("modify-in-loop", [PROCESS]),
			pattern("calcfields-in-loop", [PROCESS]),
		];
		annotateStaticCause(
			p,
			[method("ProcessRecords", "Codeunit", 50100)],
			INDEX,
		);
		expect(p[0].suggestion).toBe("BASE.");
		expect(p[1].suggestion).toBe("BASE.");
	});

	test("is a no-op without a source index", () => {
		const p = [
			pattern("single-method-dominance", [PROCESS]),
			pattern("modify-in-loop", [PROCESS]),
		];
		annotateStaticCause(
			p,
			[method("ProcessRecords", "Codeunit", 50100)],
			undefined,
		);
		expect(p[0].suggestion).toBe("BASE.");
	});

	test("never writes involvedMethods", () => {
		const before = [PROCESS];
		const p = [pattern("single-method-dominance", before)];
		annotateStaticCause(
			p,
			[method("ProcessRecords", "Codeunit", 50100)],
			INDEX,
		);
		expect(p[0].involvedMethods).toEqual([PROCESS]);
	});

	test("ignores a pattern with no involvedMethods", () => {
		const p = [pattern("single-method-dominance", [])];
		annotateStaticCause(p, [], INDEX);
		expect(p[0].suggestion).toBe("BASE.");
	});

	test("writes pattern ids bare, without backticks", () => {
		// suggestion is plain text in the terminal formatter and HTML-escaped in
		// the HTML one, so backticks would reach the user as punctuation.
		const p = [
			pattern("single-method-dominance", [PROCESS]),
			pattern("modify-in-loop", [PROCESS]),
		];
		annotateStaticCause(
			p,
			[method("ProcessRecords", "Codeunit", 50100)],
			INDEX,
		);
		expect(p[0].suggestion).not.toContain("`");
	});

	test("the profile-only id set matches the detector registry", () => {
		expect([...PROFILE_ONLY_PATTERN_IDS].sort()).toEqual([
			"deep-call-stack",
			"event-chain",
			"event-subscriber-hotspot",
			"high-hit-count",
			"recursive-call",
			"repeated-siblings",
			"single-method-dominance",
		]);
	});
});
