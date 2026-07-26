import { describe, expect, test } from "bun:test";
import { analyzeProfile } from "../../src/core/analyzer.js";
import { annotateEstimatedSavings } from "../../src/core/what-if.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

const FIXTURES = "test/fixtures";

describe("What If estimator", () => {
	test("estimates savings for single-method-dominance pattern", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const dominance = result.patterns.find(
			(p) => p.id === "single-method-dominance",
		);
		expect(dominance).toBeDefined();
		expect(dominance!.estimatedSavings).toBeDefined();
		expect(dominance!.estimatedSavings).toBeGreaterThan(0);
		expect(dominance!.savingsExplanation).toBeTruthy();
	});

	test("estimates savings for high-hit-count pattern", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const highHit = result.patterns.find((p) => p.id === "high-hit-count");
		if (highHit) {
			expect(highHit.estimatedSavings).toBeDefined();
			expect(highHit.estimatedSavings).toBeGreaterThan(0);
			expect(highHit.savingsExplanation).toBeTruthy();
		}
	});

	test("estimates savings for recursive-call pattern", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		const recursive = result.patterns.find((p) => p.id === "recursive-call");
		expect(recursive).toBeDefined();
		expect(recursive!.estimatedSavings).toBeDefined();
		expect(recursive!.estimatedSavings).toBeGreaterThan(0);
	});

	test("does not add savings to patterns without a model", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		// deep-call-stack has no savings model
		const deep = result.patterns.find((p) => p.id === "deep-call-stack");
		if (deep) {
			expect(deep.estimatedSavings).toBeUndefined();
		}
	});

	test("modify-in-loop savings match what ModifyAll was measured to buy", () => {
		// Measured on BC 28 (container Cronus28), 20,000 rows in a plain custom
		// table: a Modify loop took 2584 ms, ModifyAll 2409 ms -- 7%. Statement
		// counts agreed (2005 vs 2004): ModifyAll issues one UPDATE per row, so
		// it is not a set-based operation and cannot save a round-trip it never
		// avoids. The old model claimed 60%, which would have told a user to
		// expect an order of magnitude more than the fix delivers.
		const patterns: DetectedPattern[] = [
			{
				id: "modify-in-loop",
				severity: "critical",
				title: "Modify() inside loop in PostLines",
				description: "test pattern",
				impact: 1_000_000,
				involvedMethods: ["PostLines (Codeunit 50300)"],
				evidence: "test evidence",
			},
		];
		annotateEstimatedSavings(patterns);
		expect(patterns[0].estimatedSavings).toBe(70_000);
		expect(patterns[0].savingsExplanation).toContain("measured");
		expect(patterns[0].savingsExplanation).not.toContain("60%");
	});

	test("calcfields-in-loop savings match what hoisting the calculation buys", () => {
		// Measured on BC 28: 2,000 parents with 10 children each, a Sum
		// FlowField backed by a SumIndexField key. CalcFields inside the loop
		// cost 2001 statements / 132 ms; SetAutoCalcFields before it cost 1
		// statement / 5 ms. That is 96%, not the 80% written from judgement --
		// this multiplier was too LOW, where modify-in-loop's was too high.
		const patterns: DetectedPattern[] = [
			{
				id: "calcfields-in-loop",
				severity: "critical",
				title: "CalcFields() inside loop in SumLines",
				description: "test pattern",
				impact: 1_000_000,
				involvedMethods: ["SumLines (Codeunit 50300)"],
				evidence: "test evidence",
			},
		];
		annotateEstimatedSavings(patterns);
		expect(patterns[0].estimatedSavings).toBe(960_000);
		expect(patterns[0].savingsExplanation).toContain("measured");
	});

	test("dangerous-call-in-loop savings match what hoisting the Commit buys", () => {
		// Measured on BC 28: a 2,000-row loop that modifies each row cost 690 ms
		// with Commit inside and 284 ms with a single Commit after -- 59%, not
		// the 90% claimed. Statement counts agree (4002 vs 2005). The shape
		// matters: the saving is bounded by whatever else the loop does, and
		// here that is one UPDATE per row.
		const patterns: DetectedPattern[] = [
			{
				id: "dangerous-call-in-loop",
				severity: "critical",
				title: "Commit() inside loop in PostBatch",
				description: "test pattern",
				impact: 1_000_000,
				involvedMethods: ["PostBatch (Codeunit 50300)"],
				evidence: "test evidence",
			},
		];
		annotateEstimatedSavings(patterns);
		expect(patterns[0].estimatedSavings).toBe(590_000);
		expect(patterns[0].savingsExplanation).toContain("measured");
	});

	test("every savings model is either measured or labelled as a rough estimate", () => {
		// Three of these multipliers were measured on BC 28 and all three were
		// wrong -- 60% vs 7%, 90% vs 59%, 80% vs 96%. A user reading a
		// microsecond figure cannot tell a container measurement from a guess
		// unless the text says so, and the ones that cannot be measured are the
		// ones whose suggested fix names no concrete edit. This pins the
		// convention so a model added later has to pick a side.
		const ids = [
			"single-method-dominance",
			"high-hit-count",
			"repeated-siblings",
			"recursive-call",
			"event-chain",
			"calcfields-in-loop",
			"modify-in-loop",
			"record-op-in-loop",
			"dangerous-call-in-loop",
			"external-call-in-loop",
		];
		const patterns: DetectedPattern[] = ids.map((id) => ({
			id,
			severity: "warning",
			title: `${id} title`,
			description: "test pattern",
			impact: 1_000_000,
			involvedMethods: ["SomeMethod (Codeunit 50300)"],
			evidence: "test evidence",
		}));
		annotateEstimatedSavings(patterns);

		for (const p of patterns) {
			expect(p.savingsExplanation).toBeTruthy();
			const text = p.savingsExplanation as string;
			const claimsMeasured = text.includes("measured on BC");
			const admitsGuess = text.includes("Rough estimate (not measured)");
			// Exactly one, never both and never neither.
			expect([claimsMeasured, admitsGuess].filter(Boolean).length).toBe(1);
		}
	});

	test("a source-only pattern gets no numeric estimate and no 0µs sentence", () => {
		// dangerous-call-in-loop and external-call-in-loop are source-only: they
		// fire without a profile, so their impact is hardcoded to 0. Multiplying
		// that by any fraction is 0, and interpolating it produced the sentence
		// "removes ~59% of the 0µs", which reads as "fixing this is worth
		// nothing" on a finding rated critical. No profile means no time to
		// estimate -- the honest output is a suggestion with no number.
		const patterns: DetectedPattern[] = [
			{
				id: "dangerous-call-in-loop",
				severity: "critical",
				title: "Commit() inside loop in PostBatch",
				description: "test pattern",
				impact: 0,
				involvedMethods: ["PostBatch (Codeunit 50300)"],
				evidence: "test evidence",
			},
		];
		annotateEstimatedSavings(patterns);
		expect(patterns[0].estimatedSavings).toBeUndefined();
		expect(patterns[0].savingsExplanation ?? "").not.toContain("0µs");
	});

	test("estimates savings for external-call-in-loop pattern", () => {
		// external-call-in-loop is source-only (never produced by
		// analyzeProfile alone -- it needs --source), so this exercises
		// annotateEstimatedSavings directly rather than through the full
		// pipeline, mirroring the sibling dangerous-call-in-loop entry it
		// sits beside in SAVINGS_MODELS. Without a model, estimatedSavings
		// stays undefined -- this test pins that the entry exists.
		const patterns: DetectedPattern[] = [
			{
				id: "external-call-in-loop",
				severity: "critical",
				title: "HttpClient.Send() inside loop in HttpSendInLoop",
				description: "test pattern",
				impact: 1000,
				involvedMethods: ["HttpSendInLoop (Codeunit 50300)"],
				evidence: "test evidence",
			},
		];
		annotateEstimatedSavings(patterns);
		expect(patterns[0].estimatedSavings).toBeDefined();
		expect(patterns[0].estimatedSavings).toBeGreaterThan(0);
		expect(patterns[0].savingsExplanation).toBeTruthy();
	});
});
