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
        maxSubtrees: 5,
        maxDepth: 5,
        minPercent: 1,
      });
      break;
    case "chains":
      callTree = serializeChainList(profile, { maxChains: 10 });
      break;
    case "adjacency":
      callTree = serializeAdjacencySummary(profile, { topMethods: 10 });
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
  const strategy = options.strategy ?? "adjacency";
  const payload = buildDeepPayload(result, profile, strategy);

  const hasSource = payload.sourceSnippets !== undefined;
  const systemPrompt = buildDeepSystemPrompt({ hasSource });

  const client = new Anthropic({ apiKey: options.apiKey });
  const model = MODEL_IDS[options.model ?? "sonnet"];

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: JSON.stringify(payload, null, 2),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  let text = textBlock?.text ?? "";
  if (response.stop_reason === "max_tokens") {
    text += "\n\n*(Response truncated)*";
  }

  const parsed = parseDeepResponse(text);

  return {
    aiFindings: parsed.findings,
    aiNarrative: parsed.narrative,
  };
}
