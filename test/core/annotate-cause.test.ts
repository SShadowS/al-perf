import { describe, expect, test } from "bun:test";
import { analyzeProfile } from "../../src/core/analyzer.js";
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

	test("a profile-only finding never cites another profile-only finding (or itself) as a sibling, even sharing an anchor", () => {
		// Guards the sibling-collection loop's
		// `if (PROFILE_ONLY_PATTERN_IDS.has(p.id)) continue;`. Without it, two
		// profile-only findings sharing an anchor would each land in
		// siblingsByAnchor and be read back as the other's (and even their own)
		// "Static analysis also flagged" sibling -- a profile-only finding
		// analyses nothing, so it must never be cited as a cause.
		const p = [
			pattern("single-method-dominance", [PROCESS]),
			pattern("recursive-call", [PROCESS]),
		];
		annotateStaticCause(
			p,
			[method("ProcessRecords", "Codeunit", 50100)],
			INDEX,
		);
		for (const finding of p) {
			expect(finding.suggestion).not.toContain("Static analysis also flagged");
			expect(finding.suggestion).not.toContain("single-method-dominance");
			expect(finding.suggestion).not.toContain("recursive-call");
		}
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

describe("annotateStaticCause wired into analyzeProfile", () => {
	test("a profile-only finding is unannotated without --source", async () => {
		const result = await analyzeProfile(
			"test/fixtures/sampling-minimal.alcpuprofile",
		);
		for (const p of result.patterns) {
			expect(p.suggestion ?? "").not.toContain("Static analysis also flagged");
			expect(p.suggestion ?? "").not.toContain("No loop or SetLoadFields");
		}
	});

	// test/fixtures/sampling-minimal.alcpuprofile's two methods resolve against
	// nothing in test/fixtures/source, so the no-source test above cannot tell
	// a correctly-wired call from a missing one -- both look identical. This
	// fixture's hot method is ProcessRecords in Codeunit 50100, which exists in
	// test/fixtures/source/CodeUnit50100.al and already carries a
	// calcfields-in-loop (and modify-in-loop, missing-setloadfields) finding,
	// so with --source both a profile-only finding (single-method-dominance)
	// and source-correlated findings land on the same involvedMethods anchor --
	// exercising the sibling-naming branch of annotateStaticCause, not just its
	// undefined-sourceIndex early return.
	test("a profile-only finding is annotated with its source-correlated siblings when --source resolves the routine", async () => {
		const result = await analyzeProfile(
			"test/fixtures/static-cause-synthetic.alcpuprofile",
			{ sourcePath: "test/fixtures/source" },
		);
		const dominance = result.patterns.find(
			(p) => p.id === "single-method-dominance",
		);
		expect(dominance).toBeDefined();
		expect(dominance!.suggestion).toContain("Static analysis also flagged");
		expect(dominance!.suggestion).toContain("calcfields-in-loop");
	});
});

test("every id emitted by runDetectors is classified profile-only", async () => {
	// The id set is a copy of knowledge that lives in patterns.ts's
	// `allDetectors`. If a new profile-only detector ships without being added
	// to the set, it would be treated as a source-correlated finding and could
	// be cited as its own cause.
	const { parseProfile } = await import("../../src/core/parser.js");
	const { processProfile } = await import("../../src/core/processor.js");
	const { runDetectors } = await import("../../src/core/patterns.js");
	const raw = await parseProfile("test/fixtures/sampling-minimal.alcpuprofile");
	const emitted = new Set(runDetectors(processProfile(raw)).map((p) => p.id));
	for (const id of emitted) {
		expect(PROFILE_ONLY_PATTERN_IDS.has(id)).toBe(true);
	}
});
