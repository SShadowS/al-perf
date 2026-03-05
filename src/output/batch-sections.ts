import type { BatchAnalysisResult } from "./batch-types.js";

export type BatchSectionType =
  | "batchSummary"
  | "activityBreakdown"
  | "recurringPatterns"
  | "cumulativeHotspots"
  | "appBreakdown"
  | "batchExplanation";

/** Requires a renderer for every batch section type. Compile error if one is missing. */
export type BatchSectionRenderers<T> = Record<BatchSectionType, (result: BatchAnalysisResult) => T>;

/** Canonical section order for all batch formatters. */
export const BATCH_SECTION_ORDER: readonly BatchSectionType[] = [
  "batchSummary",
  "batchExplanation",
  "activityBreakdown",
  "recurringPatterns",
  "cumulativeHotspots",
  "appBreakdown",
] as const;
