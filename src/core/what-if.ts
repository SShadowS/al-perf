import type { DetectedPattern } from "../types/patterns.js";

/**
 * Heuristic cost models for estimating savings per pattern type.
 * Estimates are conservative (typically 30-70% of impact) since
 * fixes rarely eliminate 100% of the cost.
 */
const SAVINGS_MODELS: Record<
	string,
	(p: DetectedPattern) => { savings: number; explanation: string }
> = {
	"single-method-dominance": (p) => ({
		savings: Math.round(p.impact * 0.3),
		explanation: `Optimizing the dominant method could save ~30% of its ${formatImpact(p.impact)} selfTime through algorithmic improvements.`,
	}),
	"high-hit-count": (p) => ({
		savings: Math.round(p.impact * 0.5),
		explanation: `Reducing call frequency (e.g., caching or batching) could save ~50% of the ${formatImpact(p.impact)} spent in high-frequency calls.`,
	}),
	"repeated-siblings": (p) => ({
		savings: Math.round(p.impact * 0.7),
		explanation: `Eliminating repeated sibling calls (likely N+1 pattern) could save ~70% of the ${formatImpact(p.impact)} by batching operations.`,
	}),
	"recursive-call": (p) => ({
		savings: Math.round(p.impact * 0.5),
		explanation: `Converting recursion to iteration or adding caching could save ~50% of the ${formatImpact(p.impact)} spent in recursive calls.`,
	}),
	"event-chain": (p) => ({
		savings: Math.round(p.impact * 0.4),
		explanation: `Consolidating the event chain could save ~40% of the ${formatImpact(p.impact)} from cascading subscriber overhead.`,
	}),
	"calcfields-in-loop": (p) => ({
		savings: Math.round(p.impact * 0.8),
		explanation: `Moving CalcFields outside the loop, or calling SetAutoCalcFields before it, could eliminate ~80% of the ${formatImpact(p.impact)} per-iteration cost. SetLoadFields does not help here — it does not accept FlowFields.`,
	}),
	// The one entry in this table backed by measurement rather than judgement.
	// ModifyAll is not set-based on BC 28: it issues one UPDATE per row, the
	// same as the loop it replaces. Measured over 20,000 rows in a plain custom
	// table -- 2584 ms for the loop, 2409 ms for ModifyAll, and 2005 vs 2004 SQL
	// statements. The saving is real but small, and it is not the round-trip
	// saving the name "batching" implies.
	"modify-in-loop": (p) => ({
		savings: Math.round(p.impact * 0.07),
		explanation: `Replacing the loop with ModifyAll saves ~7% of the ${formatImpact(p.impact)} (measured on BC 28 over 20,000 rows) -- ModifyAll still issues one UPDATE per row, so it does not remove the round-trips. The large win is modifying fewer rows: narrow the filter, or skip rows whose values are already correct.`,
	}),
	"record-op-in-loop": (p) => ({
		savings: Math.round(p.impact * 0.7),
		explanation: `Restructuring to reduce per-iteration database calls could save ~70% of the ${formatImpact(p.impact)}.`,
	}),
	"dangerous-call-in-loop": (p) => ({
		savings: Math.round(p.impact > 0 ? p.impact * 0.9 : 0),
		explanation: `Moving Commit/Error outside the loop eliminates per-iteration transaction overhead.`,
	}),
	"external-call-in-loop": (p) => ({
		savings: Math.round(p.impact > 0 ? p.impact * 0.9 : 0),
		explanation: `Hoisting the HTTP call/Sleep outside the loop (or batching the request) eliminates per-iteration network round-trip or blocking-delay overhead.`,
	}),
};

function formatImpact(us: number): string {
	if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(1)}s`;
	if (us >= 1_000) return `${(us / 1_000).toFixed(1)}ms`;
	return `${Math.round(us)}\u00b5s`;
}

/**
 * Annotate patterns with estimated savings.
 * Mutates patterns in place for efficiency.
 */
export function annotateEstimatedSavings(patterns: DetectedPattern[]): void {
	for (const p of patterns) {
		const model = SAVINGS_MODELS[p.id];
		if (model) {
			const result = model(p);
			p.estimatedSavings = result.savings;
			p.savingsExplanation = result.explanation;
		}
	}
}
