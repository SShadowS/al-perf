import type { AnalysisResult, ComparisonResult } from "../../output/types.js";

export function formatAnalysisJson(result: AnalysisResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatComparisonJson(result: ComparisonResult): string {
  return JSON.stringify(result, null, 2);
}
