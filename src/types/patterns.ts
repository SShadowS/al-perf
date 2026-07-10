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
