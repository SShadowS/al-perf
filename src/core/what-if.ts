import type { DetectedPattern } from "../types/patterns.js";

/**
 * Cost models for estimating savings per pattern type.
 *
 * Three of these were MEASURED on BC 28 (`private/matrix-probe`,
 * `private/whatif-probe`) and all three were wrong, in both directions:
 * modify-in-loop claimed 60% and buys 7%, dangerous-call-in-loop claimed 90%
 * and buys 59%, calcfields-in-loop claimed 80% and buys 96%. So the previous
 * note here — that these estimates are "conservative" — was not true; they
 * were arbitrary. Do not restore that framing.
 *
 * A model can only be measured when the suggested fix is concrete enough to
 * run: hoist the CalcFields, hoist the Commit, swap the loop for ModifyAll.
 * The rest suggest a direction rather than an edit ("reduce call frequency",
 * "restructure to reduce per-iteration database calls"), so there is no second
 * variant to time and no number to check. Those keep a rough figure so the
 * ranking stays useful, and say so in their text — a user must be able to tell
 * which of these numbers came from a container and which came from judgement.
 * If you add a model, measure it or mark it "rough estimate"; the test suite
 * enforces that every entry does one or the other.
 */
const SAVINGS_MODELS: Record<
	string,
	(p: DetectedPattern) => { savings: number; explanation: string }
> = {
	"single-method-dominance": (p) => ({
		savings: Math.round(p.impact * 0.3),
		explanation: `Rough estimate (not measured): optimizing the dominant method might save ~30% of its ${formatImpact(p.impact)} selfTime through algorithmic improvements.`,
	}),
	"high-hit-count": (p) => ({
		savings: Math.round(p.impact * 0.5),
		explanation: `Rough estimate (not measured): reducing call frequency, e.g. by caching or batching, might save ~50% of the ${formatImpact(p.impact)} spent in high-frequency calls.`,
	}),
	"repeated-siblings": (p) => ({
		savings: Math.round(p.impact * 0.7),
		explanation: `Rough estimate (not measured): eliminating repeated sibling calls (likely an N+1 pattern) might save ~70% of the ${formatImpact(p.impact)} by batching operations.`,
	}),
	"recursive-call": (p) => ({
		savings: Math.round(p.impact * 0.5),
		explanation: `Rough estimate (not measured): converting recursion to iteration, or adding caching, might save ~50% of the ${formatImpact(p.impact)} spent in recursive calls.`,
	}),
	"event-chain": (p) => ({
		savings: Math.round(p.impact * 0.4),
		explanation: `Rough estimate (not measured): consolidating the event chain might save ~40% of the ${formatImpact(p.impact)} from cascading subscriber overhead.`,
	}),
	// Measured: 2,000 parents x 10 children, Sum FlowField over a SumIndexField
	// key. CalcFields in the loop cost 2001 statements / 132 ms; the same loop
	// with SetAutoCalcFields cost 1 statement / 5 ms. The platform folds the
	// aggregate into the one query instead of issuing it per row.
	"calcfields-in-loop": (p) => ({
		savings: Math.round(p.impact * 0.96),
		explanation: `Calling SetAutoCalcFields before the loop, or moving the calculation outside it, removes ~96% of the ${formatImpact(p.impact)} (measured on BC 28: 2001 SQL statements and 132ms become 1 and 5ms over 2,000 rows) — the platform folds the aggregate into the query instead of issuing one per row. SetLoadFields does not help here — it does not accept FlowFields.`,
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
		explanation: `Rough estimate (not measured): restructuring to reduce per-iteration database calls might save ~70% of the ${formatImpact(p.impact)}.`,
	}),
	// Measured: a 2,000-row loop that modifies each row cost 4002 statements /
	// 690 ms with Commit inside, and 2005 / 284 ms with one Commit after. The
	// saving is bounded by whatever else the loop does -- here one UPDATE per
	// row -- so 59% is the figure for a loop that writes, which is the shape
	// Commit-in-loop almost always appears in.
	"dangerous-call-in-loop": (p) => ({
		savings: Math.round(p.impact * 0.59),
		explanation: `Moving Commit outside the loop removes ~59% of the ${formatImpact(p.impact)} (measured on BC 28 over 2,000 rows: 690ms becomes 284ms, and 4002 SQL statements become 2005) by collapsing N write transactions into one.`,
	}),
	"external-call-in-loop": (p) => ({
		savings: Math.round(p.impact * 0.9),
		explanation: `Rough estimate (not measured): hoisting the HTTP call or Sleep outside the loop, or batching the request, removes the per-iteration network round-trip or blocking delay.`,
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
		if (!model) continue;
		// A saving is a fraction of measured time, so with no measured time
		// there is nothing to take a fraction of. Source-only patterns
		// (dangerous-call-in-loop, external-call-in-loop) fire without a
		// profile and carry impact 0 by construction, and annotating them
		// produced "removes ~59% of the 0µs" on findings rated critical —
		// which reads as "fixing this is worth nothing". Leave both fields
		// unset: the finding still carries its own `suggestion`, which is
		// where the actionable advice lives.
		if (p.impact <= 0) continue;
		const result = model(p);
		p.estimatedSavings = result.savings;
		p.savingsExplanation = result.explanation;
	}
}
