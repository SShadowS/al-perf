import { matchExactToSource } from "../source/locator.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern } from "../types/patterns.js";
import type { SourceIndex } from "../types/source-index.js";
import { formatMethodBreakdownRef } from "./method-ref.js";

/**
 * Detectors that fire from a profile alone. They know a method name, a time and
 * a hit count, and nothing about what the code does — which is why their advice
 * cannot be specific without help, and why they are the only patterns this pass
 * annotates.
 *
 * `allDetectors` in patterns.ts is the real registry, and it is not exported —
 * nothing here can check against it directly. What IS checked: a test in
 * annotate-cause.test.ts runs `runDetectors` over
 * test/fixtures/sampling-minimal.alcpuprofile and asserts every id it emits
 * is a member of this set. That is a real pin, but a partial one — it only
 * covers ids that actually FIRE on that one fixture. A profile-only detector
 * added to patterns.ts without ever firing on sampling-minimal.alcpuprofile
 * (or firing only under a shape that fixture doesn't produce) would ship
 * silently absent from this set, and its findings would then be treated as
 * source-correlated and become eligible to be cited as their own cause.
 */
export const PROFILE_ONLY_PATTERN_IDS: ReadonlySet<string> = new Set([
	"single-method-dominance",
	"high-hit-count",
	"deep-call-stack",
	"repeated-siblings",
	"event-subscriber-hotspot",
	"recursive-call",
	"event-chain",
]);

/**
 * Append what static analysis knows about a profile-only finding's routine.
 *
 * Restates findings other detectors already produced — it analyses nothing, so
 * it cannot contradict them. The join is the `involvedMethods[0]` anchor, which
 * every detector builds through `formatMethodBreakdownRef`.
 *
 * The negative claim ("no loop findings here") is fenced three ways, because it
 * is the only output here that can be a confident falsehood:
 *
 *  1. the routine must resolve on type AND id (`matchExactToSource`, never
 *     `matchAllToSource`, whose fallbacks can answer about a different object);
 *  2. the finding must name exactly one routine. Measured against patterns.ts:
 *     only `single-method-dominance` and `recursive-call` always name exactly
 *     one. The other five build multi-anchor `involvedMethods` —
 *     `high-hit-count` and `repeated-siblings` always name exactly two,
 *     `event-chain` always names its root plus every subscriber beneath it,
 *     and `deep-call-stack` / `event-subscriber-hotspot` name a
 *     variable-length set — so `[0]` is arbitrary for any of those five, and
 *     the negative claim can in practice only ever reach the first two;
 *  3. the wording names only what `analyzeProfile` actually runs. The
 *     source-ONLY family (unfiltered-findset, dangerous-call-in-loop,
 *     external-call-in-loop, nested-loops, unindexed-filter) never runs in this
 *     path, so "no database anti-patterns" would be false exactly when a
 *     routine's real problem is one of those.
 *
 * Mutates `suggestion` only. `involvedMethods` is the lifecycle fingerprint
 * anchor and is read, never written.
 */
export function annotateStaticCause(
	patterns: DetectedPattern[],
	methods: MethodBreakdown[],
	sourceIndex?: SourceIndex,
): void {
	if (!sourceIndex) return;

	const siblingsByAnchor = new Map<string, string[]>();
	for (const p of patterns) {
		if (PROFILE_ONLY_PATTERN_IDS.has(p.id)) continue;
		for (const anchor of p.involvedMethods) {
			const list = siblingsByAnchor.get(anchor) ?? [];
			if (!list.includes(p.id)) list.push(p.id);
			siblingsByAnchor.set(anchor, list);
		}
	}

	for (const p of patterns) {
		if (!PROFILE_ONLY_PATTERN_IDS.has(p.id)) continue;
		if (!p.suggestion) continue;

		const siblings = new Set<string>();
		for (const anchor of p.involvedMethods) {
			for (const id of siblingsByAnchor.get(anchor) ?? []) siblings.add(id);
		}

		if (siblings.size > 0) {
			p.suggestion = `${p.suggestion} Static analysis also flagged ${[...siblings].join(", ")} on this routine.`;
			continue;
		}

		// Negative claim from here down — every fence applies.
		if (p.involvedMethods.length !== 1) continue;
		const anchor = p.involvedMethods[0];
		const m = methods.find((x) => formatMethodBreakdownRef(x) === anchor);
		if (!m) continue;
		const exact = matchExactToSource(
			m.functionName,
			m.objectType,
			m.objectId,
			sourceIndex,
		);
		if (exact.length === 0) continue;

		p.suggestion = `${p.suggestion} No loop or SetLoadFields findings were raised for this routine.`;
	}
}
