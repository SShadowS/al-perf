export type PatternSeverity = "critical" | "warning" | "info";

export interface DetectedPattern {
  id: string;
  severity: PatternSeverity;
  title: string;
  description: string;
  impact: number;                 // Estimated microseconds
  involvedMethods: string[];      // "FunctionName (ObjectType ObjectId)"
  evidence: string;
  suggestion?: string;
  /** Estimated time savings if this pattern is fixed (microseconds) */
  estimatedSavings?: number;
  /** Human-readable explanation of the savings estimate */
  savingsExplanation?: string;
}

export type PatternDetector = (
  profile: import("./processed.js").ProcessedProfile,
) => DetectedPattern[];
