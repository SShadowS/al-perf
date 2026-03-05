// Core analysis functions (library API)
export { parseProfile, parseProfileFromRaw, detectProfileType } from "./core/parser.js";
export { processProfile } from "./core/processor.js";
export { aggregateByApp, aggregateByMethod, aggregateByObject } from "./core/aggregator.js";
export { runDetectors } from "./core/patterns.js";
export { analyzeProfile, compareProfiles } from "./core/analyzer.js";
export { drilldownMethod } from "./core/drilldown.js";
export { buildTableBreakdown } from "./core/table-view.js";

// Source correlation
export { buildSourceIndex, indexALFile } from "./source/indexer.js";
export { matchToSource, matchAllHotspots } from "./source/locator.js";
export { extractSnippet, annotateSnippet, readSourceLines } from "./source/snippets.js";
export { runSourceDetectors } from "./source/source-patterns.js";
export { runSourceOnlyDetectors } from "./source/source-only-patterns.js";
export { findCompanionZip, extractCompanionZip } from "./source/zip-extractor.js";
export { createALParser, parseALSource } from "./source/parser-init.js";
export { SourceIndexCache } from "./source/cache.js";
export { buildTableRelationGraph, tableConnectivityStats } from "./source/table-graph.js";

// Explainer
export { explainAnalysis, trimResultForPrompt, SYSTEM_PROMPT } from "./explain/explainer.js";
export type { ExplainOptions, ExplainModel } from "./explain/explainer.js";

// CLI types
export type { GateResult } from "./cli/commands/gate.js";
export type { SourceAnalysisResult } from "./cli/commands/analyze-source.js";

// MCP server
export { createMcpServer } from "./mcp/server.js";
export type { McpServerOptions } from "./mcp/server.js";

// History
export { HistoryStore } from "./history/store.js";
export type { HistoryEntry, HistoryQuery } from "./types/history.js";

// Types
export type { RawProfile, RawProfileNode, ParsedProfile, ProfileType } from "./types/profile.js";
export type { ProcessedProfile, ProcessedNode } from "./types/processed.js";
export type { AnalysisResult, ComparisonResult, MethodDelta, PatternDelta, CriticalPathStep, SubtreeDrillDown, ChildContribution, TableBreakdown, TableOperationBreakdown } from "./output/types.js";
export type { AppBreakdown, ObjectBreakdown, MethodBreakdown } from "./types/aggregated.js";
export type { DetectedPattern, PatternSeverity } from "./types/patterns.js";
export type {
  SourceIndex,
  ALFileInfo,
  ObjectInfo,
  ProcedureInfo,
  TriggerInfo,
  ProcedureFeatures,
  FieldAccessInfo,
  LoopInfo,
  RecordOpInfo,
  RecordOpType,
  LineRange,
  TableRelationInfo,
} from "./types/source-index.js";
export type { ProfileMetadata } from "./types/batch.js";
export type { BatchAnalysisResult, RecurringPattern, CumulativeHotspot, ActivitySummary } from "./output/batch-types.js";
