import Anthropic from "@anthropic-ai/sdk";
import type { AnalysisResult } from "../output/types.js";
import type { AIFinding } from "../types/ai-findings.js";
import type { ProcessedProfile } from "../types/processed.js";
import { trimResultForPrompt, type TrimmedResult } from "./explainer.js";
import { serializePrunedTree } from "./payloads/call-tree-pruned.js";
import { serializeChainList } from "./payloads/call-tree-chains.js";
import { serializeAdjacencySummary } from "./payloads/call-tree-adjacency.js";
import { buildDeepSystemPrompt } from "./prompts/schema.js";
import { parseDeepResponse } from "./response-parser.js";
import type { ExplainModel } from "./explainer.js";
import { MODEL_IDS } from "./explainer.js";
import { computeCallCost, type ApiCallCost } from "./api-cost.js";
import { config } from "../config.js";

export type CallTreeStrategy = "pruned" | "chains" | "adjacency";

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
}

export interface DeepExplainOptions {
  apiKey: string;
  model?: ExplainModel;
  strategy?: CallTreeStrategy;
}

export interface DeepExplainResult {
  aiFindings: AIFinding[];
  aiNarrative: string;
  cost: ApiCallCost;
}

export function buildDeepPayload(
  result: AnalysisResult,
  profile: ProcessedProfile,
  strategy: CallTreeStrategy,
): DeepPayload {
  const analysis = trimResultForPrompt(result);

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
      callTree = serializeAdjacencySummary(profile, { topMethods: config.deep.adjacencyTopMethods });
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

  return {
    analysis,
    callTree,
    callTreeStrategy: strategy,
    sourceSnippets: snippets.length > 0 ? snippets : undefined,
  };
}

export async function deepAnalysis(
  result: AnalysisResult,
  profile: ProcessedProfile,
  options: DeepExplainOptions,
): Promise<DeepExplainResult> {
  const strategy = options.strategy ?? config.deep.strategy;
  const payload = buildDeepPayload(result, profile, strategy);

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
  };
}
