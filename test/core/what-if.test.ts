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
