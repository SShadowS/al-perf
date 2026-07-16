export type PatternSeverity = "critical" | "warning" | "info";

export interface DetectedPattern {
	id: string;
	severity: PatternSeverity;
	title: string;
	description: string;
	impact: number; // Estimated microseconds
	involvedMethods: string[]; // "FunctionName (ObjectType ObjectId)"
	evidence: string;
	suggestion?: string;
	/** Estimated time savings if this pattern is fixed (microseconds) */
	estimatedSavings?: number;
	/** Human-readable explanation of the savings estimate */
	savingsExplanation?: string;
	/**
	 * Canonical finding identity in string form (`pattern:<16-hex>`), minted by
	 * `fingerprintPatterns` (src/lifecycle/wire.ts) per the anchor policy
	 * (anchor = involvedMethods[0]). Fallback-key identity unless al-sem fusion
	 * upgraded the anchor to a stable routine identity (fuseProfile re-mints).
	 * Absent only on pattern objects constructed outside analyzeProfile
	 * (e.g. detector unit tests).
	 */
	fingerprint?: string;
}

export type PatternDetector = (
	profile: import("./processed.js").ProcessedProfile,
) => DetectedPattern[];

/**
 * The canonical set of every pattern id the detectors can emit. Single source
 * of truth: fingerprints, docs, and any id-keyed surface should reference this
 * rather than re-listing ids.
 *
 * What is mechanically enforced, and what is NOT:
 *  - PATTERN_IDS <-> PATTERN_DOC_HEADINGS: enforced at COMPILE TIME. The map is
 *    typed `Record<PatternId, string>`, so a missing or stray key is a tsc error.
 *  - every id's heading -> its prose section exists: enforced by the completeness
 *    test in test/types/pattern-ids.test.ts.
 *  - detectors -> PATTERN_IDS: NOT enforced. `DetectedPattern.id` is a plain
 *    `string`, so a new detector emitting an unregistered id compiles and passes
 *    every test — its id is silently missing here and undocumented. This list
 *    must be updated BY HAND when a detector's `id:` literal is added, renamed,
 *    or removed (in patterns.ts / source-patterns.ts / source-only-patterns.ts).
 *    Registering the id is the one manual step; tsc and the test force the rest.
 */
export const PATTERN_IDS = [
	// profile-only (7)
	"single-method-dominance",
	"high-hit-count",
	"deep-call-stack",
	"repeated-siblings",
	"event-subscriber-hotspot",
	"recursive-call",
	"event-chain",
	// source-correlated (7)
	"calcfields-in-loop",
	"modify-in-loop",
	"insert-in-loop",
	"delete-in-loop",
	"record-op-in-loop",
	"missing-setloadfields",
	"incomplete-setloadfields",
	// source-only (7)
	"nested-loops",
	"unfiltered-findset",
	"event-subscriber-with-loop-ops",
	"event-subscriber-with-loops",
	"dangerous-call-in-loop",
	"external-call-in-loop",
	"unindexed-filter",
] as const;

/** A pattern id from the canonical `PATTERN_IDS` list. */
export type PatternId = (typeof PATTERN_IDS)[number];
