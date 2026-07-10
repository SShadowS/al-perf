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
	 * Canonical lifecycle fingerprint ("pattern:<16hex>" string form) — minted
	 * by the phase-2 fingerprint wiring. Absent when fingerprinting didn't run.
	 */
	fingerprint?: string;
}

export type PatternDetector = (
	profile: import("./processed.js").ProcessedProfile,
) => DetectedPattern[];
