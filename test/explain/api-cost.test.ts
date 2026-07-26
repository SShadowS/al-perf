import { describe, expect, test } from "bun:test";
import {
	computeCallCost,
	formatCallCost,
	formatCostSummary,
	hasExplicitPricing,
	summarizeCosts,
} from "../../src/explain/api-cost.js";
import { MODEL_IDS } from "../../src/explain/explainer.js";

// Every cost assertion below pins an explicit date. Without one they would
// compute against Date.now() and silently change answer when Sonnet 5's
// introductory pricing lapses on 2026-09-01 — a test that breaks on a calendar
// date rather than on a code change.
const AT_STANDARD_RATES = new Date("2026-09-01T00:00:00Z");

describe("computeCallCost", () => {
	// Anthropic publishes Sonnet 5 at introductory $2/$10 per MTok through
	// 2026-08-31, reverting to $3/$15 on 2026-09-01. Both figures are
	// documented, so the cutover is encoded rather than picked: hardcoding
	// either one is knowingly wrong on one side of a known date, and this
	// number reaches users as a dollar amount.
	const DURING_INTRO = new Date("2026-08-15T00:00:00Z");
	const AFTER_INTRO = new Date("2026-09-01T00:00:00Z");

	test("sonnet 5 introductory pricing before the cutover", () => {
		const cost = computeCallCost(
			"explain",
			"claude-sonnet-5",
			1_000_000,
			1_000_000,
			DURING_INTRO,
		);
		// 1M input * $2/M + 1M output * $10/M = $12
		expect(cost.call).toBe("explain");
		expect(cost.model).toBe("claude-sonnet-5");
		expect(cost.inputTokens).toBe(1_000_000);
		expect(cost.outputTokens).toBe(1_000_000);
		expect(cost.cost).toBeCloseTo(12, 4);
	});

	test("sonnet 5 standard pricing from the cutover onward", () => {
		const cost = computeCallCost(
			"explain",
			"claude-sonnet-5",
			1_000_000,
			1_000_000,
			AFTER_INTRO,
		);
		// 1M input * $3/M + 1M output * $15/M = $18
		expect(cost.cost).toBeCloseTo(18, 4);
	});

	test("opus 5 pricing does not vary by date", () => {
		const before = computeCallCost(
			"deep",
			"claude-opus-5",
			1_000_000,
			1_000_000,
			DURING_INTRO,
		);
		const after = computeCallCost(
			"deep",
			"claude-opus-5",
			1_000_000,
			1_000_000,
			AFTER_INTRO,
		);
		// 1M input * $5/M + 1M output * $25/M = $30
		expect(before.cost).toBeCloseTo(30, 4);
		expect(after.cost).toBeCloseTo(30, 4);
	});

	test("the shipped MODEL_IDS all have explicit pricing, not the fallback", () => {
		// A model id bumped without a matching PRICING entry silently bills at
		// the default rate and reports a wrong dollar figure to the user.
		for (const id of Object.values(MODEL_IDS)) {
			expect(hasExplicitPricing(id)).toBe(true);
		}
	});

	test("unknown model uses default (sonnet) pricing", () => {
		const cost = computeCallCost(
			"test",
			"claude-future-model",
			1_000_000,
			1_000_000,
			AT_STANDARD_RATES,
		);
		expect(cost.cost).toBeCloseTo(18, 4);
	});

	test("small token counts produce fractional costs", () => {
		const cost = computeCallCost(
			"explain",
			"claude-sonnet-5",
			5000,
			800,
			AT_STANDARD_RATES,
		);
		// 5000 * 3/1M + 800 * 15/1M = 0.015 + 0.012 = 0.027
		expect(cost.cost).toBeCloseTo(0.027, 6);
	});
});

describe("summarizeCosts", () => {
	test("aggregates multiple calls", () => {
		const calls = [
			computeCallCost(
				"explain",
				"claude-sonnet-5",
				4000,
				800,
				AT_STANDARD_RATES,
			),
			computeCallCost("deep", "claude-sonnet-5", 8000, 1500, AT_STANDARD_RATES),
		];
		const summary = summarizeCosts(calls);
		expect(summary.calls).toHaveLength(2);
		expect(summary.totalInputTokens).toBe(12000);
		expect(summary.totalOutputTokens).toBe(2300);
		expect(summary.totalCost).toBeCloseTo(calls[0].cost + calls[1].cost, 6);
	});

	test("empty calls array produces zero totals", () => {
		const summary = summarizeCosts([]);
		expect(summary.totalInputTokens).toBe(0);
		expect(summary.totalOutputTokens).toBe(0);
		expect(summary.totalCost).toBe(0);
	});
});

describe("formatCallCost", () => {
	test("formats a single call", () => {
		const cost = computeCallCost(
			"explain",
			"claude-sonnet-5",
			5000,
			800,
			AT_STANDARD_RATES,
		);
		const formatted = formatCallCost(cost);
		expect(formatted).toBe("explain: 5000in/800out $0.0270");
	});
});

describe("formatCostSummary", () => {
	test("formats multiple calls with total", () => {
		const calls = [
			computeCallCost(
				"explain",
				"claude-sonnet-5",
				4000,
				800,
				AT_STANDARD_RATES,
			),
			computeCallCost("deep", "claude-sonnet-5", 8000, 1500, AT_STANDARD_RATES),
		];
		const summary = summarizeCosts(calls);
		const formatted = formatCostSummary(summary);
		expect(formatted).toContain("explain: 4000in/800out");
		expect(formatted).toContain("deep: 8000in/1500out");
		expect(formatted).toContain("| total: 12000in/2300out");
	});
});
