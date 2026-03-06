import type { AnalysisResult } from "./types.js";

export type AnalysisSectionType =
  | "summary"
  | "hotspots"
  | "criticalPath"
  | "patterns"
  | "appBreakdown"
  | "tableBreakdown"
  | "objectBreakdown"
  | "explanation"
  | "aiNarrative"
  | "aiFindings";

/** Requires a renderer for every section type. Compile error if one is missing. */
export type SectionRenderers<T> = Record<AnalysisSectionType, (result: AnalysisResult) => T>;

/** Canonical section order for all formatters. */
export const SECTION_ORDER: readonly AnalysisSectionType[] = [
  "summary",
  "explanation",
  "appBreakdown",
  "tableBreakdown",
  "hotspots",
  "criticalPath",
  "patterns",
  "objectBreakdown",
  "aiNarrative",
  "aiFindings",
] as const;
