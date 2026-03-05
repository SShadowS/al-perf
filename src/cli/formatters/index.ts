import type { AnalysisResult, ComparisonResult } from "../../output/types.js";
import type { BatchAnalysisResult } from "../../output/batch-types.js";
import type { OutputFormat } from "./auto.js";
import { resolveFormat } from "./auto.js";
import { formatAnalysisJson, formatComparisonJson } from "./json.js";
import { formatAnalysisMarkdown, formatComparisonMarkdown } from "./markdown.js";
import { formatAnalysisTerminal, formatComparisonTerminal } from "./terminal.js";
import { formatBatchTerminal } from "./batch-terminal.js";

export type { OutputFormat } from "./auto.js";

export function formatAnalysis(result: AnalysisResult, format: OutputFormat): string {
  const resolved = resolveFormat(format);
  switch (resolved) {
    case "json": return formatAnalysisJson(result);
    case "markdown": return formatAnalysisMarkdown(result);
    case "terminal": return formatAnalysisTerminal(result);
  }
}

export function formatComparison(result: ComparisonResult, format: OutputFormat): string {
  const resolved = resolveFormat(format);
  switch (resolved) {
    case "json": return formatComparisonJson(result);
    case "markdown": return formatComparisonMarkdown(result);
    case "terminal": return formatComparisonTerminal(result);
  }
}

export function formatBatch(result: BatchAnalysisResult, format: OutputFormat): string {
  const resolved = resolveFormat(format);
  switch (resolved) {
    case "json": return JSON.stringify(result, null, 2);
    case "markdown": return JSON.stringify(result, null, 2); // Placeholder until markdown formatter
    case "terminal": return formatBatchTerminal(result);
  }
}
