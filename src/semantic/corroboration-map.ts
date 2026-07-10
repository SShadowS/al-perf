/**
 * Cross-signal corroboration map (P3.1, spec Revision-2 R3-5/R3-6/R3-7).
 *
 * SOUNDNESS: ONLY al-perf RUNTIME-shape detectors (src/core/patterns.ts) may corroborate an al-sem
 * finding — they are real measured runtime evidence. al-perf's source-static (source-patterns.ts) and
 * source-only (source-only-patterns.ts) detectors are al-perf's OWN static scans; an agreement between
 * two static analyses is NOT runtime evidence and must NEVER earn the "runtime-correlated" badge. This
 * map therefore contains ONLY runtime-provenance entries; any pattern id absent from it is not
 * corroborating. Co-occurrence on the same routine is CORRELATION, not causation (R3-6) — the badge is
 * "runtime-correlated", never "runtime-confirmed".
 */
export interface CorroborationEntry {
	/** Always "runtime" — the map only holds runtime-provenance patterns (the soundness invariant). */
	provenance: "runtime";
	/** al-sem detector ids this runtime pattern describes the SAME phenomenon as. */
	alSemDetectors: string[];
	/** Which involvedMethods[] entry is the loop/recursion-OWNING routine the finding sits on. */
	anchorIndex: number;
}

export const CORROBORATION_MAP: Record<string, CorroborationEntry> = {
	// ≥50 sibling calls to the same child under one parent — the parent owns the loop.
	// involvedMethods = [formatMethodRef(node), formatMethodRef(representative)]
	//                 = [parent, representativeChild]
	// Verified against src/core/patterns.ts detectRepeatedSiblings.
	"repeated-siblings": {
		provenance: "runtime",
		alSemDetectors: [
			"d1-db-op-in-loop",
			"d4-repeated-lookup-in-loop",
			"d48-io-in-loop",
		],
		anchorIndex: 0, // involvedMethods[0] is the parent (loop owner)
	},
	// child fires ≫ parent — the PARENT (involvedMethods[1]) contains the loop/fan-out.
	// involvedMethods = [formatMethodRef(node), formatMethodRef(node.parent)]
	//                 = [child, parent]
	// Verified against src/core/patterns.ts detectHighHitCount.
	"high-hit-count": {
		provenance: "runtime",
		alSemDetectors: [
			"d1-db-op-in-loop",
			"d4-repeated-lookup-in-loop",
			"d48-io-in-loop",
		],
		anchorIndex: 1, // involvedMethods[1] is the parent (loop owner)
	},
	// method observed as its own ancestor at runtime.
	// involvedMethods = [formatMethodRef(node)] — the recursive method itself.
	// Verified against src/core/patterns.ts detectRecursion.
	"recursive-call": {
		provenance: "runtime",
		alSemDetectors: ["d7-recursive-event-expansion"],
		anchorIndex: 0,
	},
};

/** True iff this runtime pattern corroborates this al-sem detector (same phenomenon). */
export function corroboratesDetector(
	patternId: string,
	alSemDetector: string,
): boolean {
	const entry = CORROBORATION_MAP[patternId];
	return entry?.alSemDetectors.includes(alSemDetector) ?? false;
}
