/**
 * corroborate.ts — Pure corroboration pass (P3.1, spec Revision-2 R3-7).
 *
 * Enriches `FusedModel.attributions` in place: for each `status === "matched"`
 * attribution whose findings include a detector that is corroborated by a runtime
 * pattern anchored to that routine, records the matching pattern ids on
 * `SemanticAttribution.corroboratingPatterns` (sorted, deduped; omitted if empty).
 *
 * PURE — no I/O, no filesystem, no subprocess calls.
 *
 * R3-7 honesty gates:
 *  - ONLY `status === "matched"` attributions are enriched (ambiguous/blind-spot skip).
 *  - Pattern anchor: `involvedMethods[entry.anchorIndex]` must match the attribution's
 *    method (compared via the same formatMethodRef format the detectors use).
 *  - Detector corroboration: `corroboratesDetector(patternId, detector)` must be true
 *    for at least one of the attribution's findings.
 */

import type { MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern } from "../types/patterns.js";
import type { FusedModel } from "../types/fused.js";
import {
	CORROBORATION_MAP,
	corroboratesDetector,
} from "./corroboration-map.js";
import { methodAttrKey } from "./correlate.js";

// ---------------------------------------------------------------------------
// Method ref formatting
//
// Must match the format emitted by formatMethodRef in src/core/patterns.ts:
//   `${functionName} (${objectType} ${objectId})`
//
// formatMethodRef is exported from src/core/patterns.ts, but importing the full
// patterns module here would create a dependency on ProcessedNode/ProcessedProfile
// types that belong to the runtime layer. Since the format is a trivial template
// string, we replicate it here and keep the shapes independent.
//
// TODO: share formatMethodRef with src/core/patterns.ts (extract to a shared
// helper) so the two definitions cannot drift.
// ---------------------------------------------------------------------------

function formatMethodRef(m: MethodBreakdown): string {
	return `${m.functionName} (${m.objectType} ${m.objectId})`;
}

// ---------------------------------------------------------------------------
// corroborate — the public entry point
// ---------------------------------------------------------------------------

/**
 * Mutates `fused.attributions` in place, setting
 * `SemanticAttribution.corroboratingPatterns` (sorted, deduped) on each
 * `status === "matched"` attribution whose findings are corroborated by a
 * runtime pattern anchored to that routine.
 *
 * Skips attributions with `status !== "matched"` (R3-7 gate).
 * Omits `corroboratingPatterns` entirely when no corroboration applies.
 *
 * @param fused    The FusedModel to enrich (mutated in place).
 * @param methods  The MethodBreakdown[] used to build the fused model.
 * @param patterns The DetectedPattern[] from the current al-perf analysis run.
 */
export function corroborate(
	fused: FusedModel,
	methods: MethodBreakdown[],
	patterns: DetectedPattern[],
): void {
	if (patterns.length === 0) return;

	// Build a lookup from methodAttrKey → set of corroborating runtime pattern ids.
	//
	// For each mapped pattern, take the anchor method = involvedMethods[anchorIndex],
	// match it against the live methods[] by comparing formatMethodRef(m) to the
	// anchor string. The matched method's methodAttrKey is the map key.
	const corroborationByKey = new Map<string, Set<string>>();

	for (const pattern of patterns) {
		const entry = CORROBORATION_MAP[pattern.id];
		if (!entry) continue; // unmapped pattern — not a corroboration signal

		const anchorStr = pattern.involvedMethods[entry.anchorIndex];
		if (anchorStr === undefined) continue; // guard: anchorIndex out of range

		// Match the anchor display string to a live method.
		for (const m of methods) {
			if (formatMethodRef(m) === anchorStr) {
				const key = methodAttrKey(m);
				const existing = corroborationByKey.get(key);
				if (existing) {
					existing.add(pattern.id);
				} else {
					corroborationByKey.set(key, new Set([pattern.id]));
				}
				break; // first match wins; each pattern has exactly one anchor method
			}
		}
	}

	if (corroborationByKey.size === 0) return;

	// Enrich matched attributions.
	for (const [attrKey, attribution] of fused.attributions) {
		// R3-7 gate: only matched attributions are enriched.
		if (attribution.status !== "matched") continue;

		const anchored = corroborationByKey.get(attrKey);
		if (!anchored) continue;

		// Filter to patterns whose alSemDetectors overlap with this attribution's findings.
		const corroborating = new Set<string>();
		for (const patternId of anchored) {
			const hasOverlap = attribution.findings.some((f) =>
				corroboratesDetector(patternId, f.detector),
			);
			if (hasOverlap) {
				corroborating.add(patternId);
			}
		}

		if (corroborating.size > 0) {
			attribution.corroboratingPatterns = [...corroborating].sort();
		}
	}
}
