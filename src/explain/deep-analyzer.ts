import Anthropic from "@anthropic-ai/sdk";
import type { AnalysisResult } from "../output/types.js";
import type { AIFinding } from "../types/ai-findings.js";
import type { ProcessedProfile } from "../types/processed.js";
import { trimResultForPrompt, type TrimmedResult, type AiDebugInfo } from "./explainer.js";
import { serializePrunedTree } from "./payloads/call-tree-pruned.js";
import { serializeChainList } from "./payloads/call-tree-chains.js";
import { serializeAdjacencySummary } from "./payloads/call-tree-adjacency.js";
import { buildDeepSystemPrompt } from "./prompts/schema.js";
import { parseDeepResponse } from "./response-parser.js";
import type { ExplainModel } from "./explainer.js";
import { MODEL_IDS } from "./explainer.js";
import { computeCallCost, type ApiCallCost } from "./api-cost.js";
import { config } from "../config.js";
import { computeDiagnostics, type ProfileDiagnostics } from "./diagnostics.js";
import { extractSqlPatterns } from "./payloads/sql-patterns.js";
import { extractCallGraph } from "./payloads/call-graph.js";
import { extractAstSummaries } from "./payloads/ast-summary.js";
import type { SourceIndex } from "../types/source-index.js";

export type CallTreeStrategy = "pruned" | "chains" | "adjacency";

export interface PayloadConfig {
  callTreeTop: number;
  includeDiagnostics: false | "lite" | "full";
  includeTableBreakdown: boolean;
  includeAst: boolean;
  includeCallGraph: boolean;
  includeSqlPatterns: boolean;
}

export const PAYLOAD_PRESETS: Record<string, PayloadConfig> = {
  baseline: {
    callTreeTop: 10,
    includeDiagnostics: false,
    includeTableBreakdown: false,
    includeAst: false,
    includeCallGraph: false,
    includeSqlPatterns: false,
  },
  "+diagnostics-lite": {
    callTreeTop: 10,
    includeDiagnostics: "lite",
    includeTableBreakdown: false,
    includeAst: false,
    includeCallGraph: false,
    includeSqlPatterns: false,
  },
  "+calltree15": {
    callTreeTop: 15,
    includeDiagnostics: false,
    includeTableBreakdown: false,
    includeAst: false,
    includeCallGraph: false,
    includeSqlPatterns: false,
  },
  "+ast": {
    callTreeTop: 10,
    includeDiagnostics: false,
    includeTableBreakdown: false,
    includeAst: true,
    includeCallGraph: false,
    includeSqlPatterns: false,
  },
  "+callgraph": {
    callTreeTop: 10,
    includeDiagnostics: false,
    includeTableBreakdown: false,
    includeAst: false,
    includeCallGraph: true,
    includeSqlPatterns: false,
  },
  "+sqlpatterns": {
    callTreeTop: 10,
    includeDiagnostics: false,
    includeTableBreakdown: false,
    includeAst: false,
    includeCallGraph: false,
    includeSqlPatterns: true,
  },
  current: {
    callTreeTop: 15,
    includeDiagnostics: "full",
    includeTableBreakdown: true,
    includeAst: false,
    includeCallGraph: false,
    includeSqlPatterns: false,
  },
};

export interface DeepPayload {
  analysis: TrimmedResult;
  callTree: unknown;
  callTreeStrategy: CallTreeStrategy;
  sourceSnippets?: Array<{
    method: string;
    objectType: string;
    objectId: number;
    file: string;
    lineStart: number;
    lineEnd: number;
    source: string;
  }>;
  diagnostics?: ProfileDiagnostics;
  sqlPatterns?: unknown;
  callGraph?: unknown;
  astSummaries?: unknown;
}

export interface DeepExplainOptions {
  apiKey: string;
  model?: ExplainModel;
  strategy?: CallTreeStrategy;
  payloadConfig?: PayloadConfig;
}

export interface DeepExplainResult {
  aiFindings: AIFinding[];
  aiNarrative: string;
  cost: ApiCallCost;
  debugInfo: AiDebugInfo;
}

export function buildDeepPayload(
  result: AnalysisResult,
  profile: ProcessedProfile,
  strategy: CallTreeStrategy,
  payloadConfig?: PayloadConfig,
  sourceIndex?: SourceIndex,
): DeepPayload {
  const analysis = trimResultForPrompt(result);

  // Optionally strip tableBreakdown
  if (payloadConfig && !payloadConfig.includeTableBreakdown) {
    delete analysis.tableBreakdown;
  }

  const topMethods = payloadConfig?.callTreeTop ?? config.deep.adjacencyTopMethods;

  let callTree: unknown;
  switch (strategy) {
    case "pruned":
      callTree = serializePrunedTree(profile, {
        maxSubtrees: config.deep.prunedMaxSubtrees,
        maxDepth: config.deep.prunedMaxDepth,
        minPercent: config.deep.prunedMinPercent,
      });
      break;
    case "chains":
      callTree = serializeChainList(profile, { maxChains: config.deep.chainsMaxChains });
      break;
    case "adjacency":
      callTree = serializeAdjacencySummary(profile, { topMethods });
      break;
  }

  // Collect source snippets from hotspots that have both sourceSnippet and sourceLocation
  const snippets = result.hotspots
    .filter((h) => h.sourceSnippet && h.sourceLocation)
    .map((h) => ({
      method: h.functionName,
      objectType: h.objectType,
      objectId: h.objectId,
      file: h.sourceLocation!.filePath,
      lineStart: h.sourceLocation!.lineStart,
      lineEnd: h.sourceLocation!.lineEnd,
      source: h.sourceSnippet!,
    }));

  // Diagnostics — controlled by payloadConfig
  let diagnostics: ProfileDiagnostics | undefined;
  if (!payloadConfig || payloadConfig.includeDiagnostics !== false) {
    const full = computeDiagnostics(profile, result);
    if (payloadConfig?.includeDiagnostics === "lite") {
      diagnostics = {
        coldCacheScore: full.coldCacheScore,
        coldCacheWarning: full.coldCacheWarning,
        wallClockGapRatio: full.wallClockGapRatio,
        wallClockGapNote: full.wallClockGapNote,
        // Omit heavy fields
        transactionCount: 0,
        tableAccessMap: [],
        healthScoreNote: null,
        scaleNote: null,
      };
    } else {
      diagnostics = full;
    }
  }

  const payload: DeepPayload = {
    analysis,
    callTree,
    callTreeStrategy: strategy,
    sourceSnippets: snippets.length > 0 ? snippets : undefined,
  };

  if (diagnostics) {
    payload.diagnostics = diagnostics;
  }

  // Optional payload extensions controlled by PayloadConfig
  if (payloadConfig?.includeSqlPatterns) {
    const sqlPatterns = extractSqlPatterns(profile.allNodes);
    if (sqlPatterns.length > 0) {
      payload.sqlPatterns = sqlPatterns;
    }
  }

  if (payloadConfig?.includeCallGraph) {
    const callGraph = extractCallGraph(profile.allNodes, topMethods);
    if (callGraph.nodes.length > 0) {
      payload.callGraph = callGraph;
    }
  }

  if (payloadConfig?.includeAst && sourceIndex) {
    const astSummaries = extractAstSummaries(result.hotspots, sourceIndex);
    if (astSummaries.length > 0) {
      payload.astSummaries = astSummaries;
    }
  }

  return payload;
}

export async function deepAnalysis(
  result: AnalysisResult,
  profile: ProcessedProfile,
  options: DeepExplainOptions,
): Promise<DeepExplainResult> {
  const strategy = options.strategy ?? config.deep.strategy;
  const payload = buildDeepPayload(result, profile, strategy, options.payloadConfig);

  const hasSource = payload.sourceSnippets !== undefined;
  const systemPrompt = buildDeepSystemPrompt({ hasSource });

  const client = new Anthropic({ apiKey: options.apiKey });
  const model = MODEL_IDS[options.model ?? config.defaultModel];

  const response = await client.messages.create({
    model,
    max_tokens: config.deep.maxTokens,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: JSON.stringify(payload, null, 2),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock?.text ?? "";

  const parsed = parseDeepResponse(text);

  // If truncated, note it in the narrative
  if (response.stop_reason === "max_tokens" && parsed.narrative) {
    parsed.narrative += "\n\n*(Response truncated)*";
  }

  const cost = computeCallCost(
    "deep",
    model,
    response.usage.input_tokens,
    response.usage.output_tokens,
  );

  return {
    aiFindings: parsed.findings,
    aiNarrative: parsed.narrative,
    cost,
    debugInfo: {
      systemPrompt,
      userPayload: payload,
      rawResponse: response,
    },
  };
}
