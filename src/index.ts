// Core analysis functions (library API)
export { parseProfile, parseProfileFromRaw, detectProfileType } from "./core/parser.js";
export { processProfile } from "./core/processor.js";
export { aggregateByApp, aggregateByMethod, aggregateByObject } from "./core/aggregator.js";
export { runDetectors } from "./core/patterns.js";
export { analyzeProfile, compareProfiles } from "./core/analyzer.js";

// Types
export type { RawProfile, RawProfileNode, ParsedProfile, ProfileType } from "./types/profile.js";
export type { ProcessedProfile, ProcessedNode } from "./types/processed.js";
export type { AnalysisResult, ComparisonResult, MethodDelta } from "./output/types.js";
export type { AppBreakdown, ObjectBreakdown, MethodBreakdown } from "./types/aggregated.js";
export type { DetectedPattern, PatternSeverity } from "./types/patterns.js";
