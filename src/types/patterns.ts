export type PatternSeverity = "critical" | "warning" | "info";

export interface DetectedPattern {
  id: string;
  severity: PatternSeverity;
  title: string;
  description: string;
  impact: number;                 // Estimated microseconds
  involvedMethods: string[];      // "FunctionName (ObjectType ObjectId)"
  evidence: string;
}

export type PatternDetector = (
  profile: import("./processed.js").ProcessedProfile,
) => DetectedPattern[];
