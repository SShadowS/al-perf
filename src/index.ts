// Core analysis functions (library API)

// al-sem fusion (Phase P1) — opt-in, additive
export { fuseProfile } from "./semantic/fuse.js";
export type { FuseOptions, FuseResult } from "./semantic/fuse.js";
export type {
	AttributionConfidence,
	CorrelationStatus,
	CorrelationSummary,
	EngineMetadata,
	FusedModel,
	MismatchWarning,
	SemanticAttribution,
} from "./types/fused.js";

export type { SourceAnalysisResult } from "./cli/commands/analyze-source.js";
// CLI types
export type { GateResult } from "./cli/commands/gate.js";
export {
	aggregateByApp,
	aggregateByMethod,
	aggregateByObject,
} from "./core/aggregator.js";
export { analyzeProfile, compareProfiles } from "./core/analyzer.js";
export type { BatchOptions } from "./core/batch-analyzer.js";
export { aggregateResults, analyzeBatch } from "./core/batch-analyzer.js";
export { drilldownMethod } from "./core/drilldown.js";
export {
	detectProfileType,
	parseProfile,
	parseProfileFromRaw,
} from "./core/parser.js";
export { runDetectors } from "./core/patterns.js";
export { processProfile } from "./core/processor.js";
export { buildTableBreakdown } from "./core/table-view.js";
export type { ApiCallCost, ApiCostSummary } from "./explain/api-cost.js";
export {
	computeCallCost,
	formatCallCost,
	formatCostSummary,
	summarizeCosts,
} from "./explain/api-cost.js";
export type { BatchExplainResult } from "./explain/batch-explainer.js";
export {
	BATCH_SYSTEM_PROMPT,
	explainBatchAnalysis,
	trimBatchResultForPrompt,
} from "./explain/batch-explainer.js";
export {
	buildDeepPayload,
	type CallTreeStrategy,
	type DeepExplainOptions,
	type DeepExplainResult,
	type DeepPayload,
	deepAnalysis,
} from "./explain/deep-analyzer.js";
export type {
	AiDebugInfo,
	ExplainModel,
	ExplainOptions,
	ExplainResult,
} from "./explain/explainer.js";
// Explainer
export {
	explainAnalysis,
	SYSTEM_PROMPT,
	trimResultForPrompt,
} from "./explain/explainer.js";
export { serializeAdjacencySummary } from "./explain/payloads/call-tree-adjacency.js";
export { serializeChainList } from "./explain/payloads/call-tree-chains.js";
export { serializePrunedTree } from "./explain/payloads/call-tree-pruned.js";
export {
	type DeepAnalysisResponse,
	parseDeepResponse,
} from "./explain/response-parser.js";
// History
export { HistoryStore } from "./history/store.js";
export type { McpServerOptions } from "./mcp/server.js";
// MCP server
export { createMcpServer } from "./mcp/server.js";
export type {
	ActivitySummary,
	BatchAnalysisResult,
	CumulativeHotspot,
	RecurringPattern,
} from "./output/batch-types.js";
export type {
	AnalysisResult,
	ChildContribution,
	ComparisonResult,
	CriticalPathStep,
	MethodDelta,
	PatternDelta,
	SubtreeDrillDown,
	TableBreakdown,
	TableOperationBreakdown,
} from "./output/types.js";
export { SourceIndexCache } from "./source/cache.js";
// Source correlation
export { buildSourceIndex, indexALFile } from "./source/indexer.js";
export { matchAllHotspots, matchToSource } from "./source/locator.js";
export { createALParser, parseALSource } from "./source/parser-init.js";
export {
	annotateSnippet,
	extractSnippet,
	readSourceLines,
} from "./source/snippets.js";
export { runSourceOnlyDetectors } from "./source/source-only-patterns.js";
export { runSourceDetectors } from "./source/source-patterns.js";
export {
	buildTableRelationGraph,
	tableConnectivityStats,
} from "./source/table-graph.js";
export {
	extractCompanionZip,
	findCompanionZip,
} from "./source/zip-extractor.js";
export type {
	AppBreakdown,
	MethodBreakdown,
	ObjectBreakdown,
} from "./types/aggregated.js";
export type { AIFinding } from "./types/ai-findings.js";
export type { ProfileMetadata } from "./types/batch.js";
export type { HistoryEntry, HistoryQuery } from "./types/history.js";
export type { DetectedPattern, PatternSeverity } from "./types/patterns.js";
export type { ProcessedNode, ProcessedProfile } from "./types/processed.js";
// Types
export type {
	ParsedProfile,
	ProfileType,
	RawProfile,
	RawProfileNode,
} from "./types/profile.js";
export type {
	ALFileInfo,
	FieldAccessInfo,
	LineRange,
	LoopInfo,
	ObjectInfo,
	ProcedureFeatures,
	ProcedureInfo,
	RecordOpInfo,
	RecordOpType,
	SourceIndex,
	TableRelationInfo,
	TriggerInfo,
} from "./types/source-index.js";
