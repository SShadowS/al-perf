import Anthropic from "@anthropic-ai/sdk";
import type { AnalysisResult } from "../output/types.js";
import { computeCallCost, type ApiCallCost } from "./api-cost.js";
import { config } from "../config.js";

export const SYSTEM_PROMPT = `You are a Business Central AL performance expert. You are given the JSON output of a profile analysis. Write a concise, actionable summary covering:

1. What the profile captured (type, duration, scale)
2. The main performance story — identify the dominant call chains and explain WHY they're slow, not just that they are
3. Group related patterns by root cause instead of listing them individually (e.g. "ApplyItemLedgEntry has 15 record ops in loops" not 15 separate findings)
4. App breakdown — which extensions are responsible
5. Top 2-3 concrete recommendations, prioritized by impact

## Common BC performance scenarios to consider

Before recommending code fixes, consider whether the profile shows infrastructure/environment behavior rather than application code issues:

- **Service tier restart / metadata cache warming**: After a service tier restart, the metadata cache is cold. Profiles will show disproportionate time in system metadata queries (e.g. "Application Object Metadata", "Translation Text", system SQL on metadata tables). This is transient and not a code issue — subsequent runs will be fast. The signature is high hit counts on metadata-related SQL statements with no corresponding application logic driving them.
- **First session after deployment**: JIT compilation overhead inflates early measurements. The first execution of code paths after deployment is not representative of steady-state performance.
- **Background vs. interactive sessions**: Job queue entries and scheduled tasks have different performance characteristics than UI-driven flows. Don't compare them directly or apply UI optimization advice to batch processing.
- **Permission checks**: Environments with many permission sets can cause disproportionate time in permission validation. This is a configuration/licensing concern, not a code issue.
- **Data volume vs. code issue**: High hit counts on FindSet/FindFirst may indicate large tables with missing filters or missing keys rather than code bugs. Check whether the issue is the query pattern or the data volume before recommending code changes.

If the profile is dominated by infrastructure concerns (metadata loading, JIT, permissions), say so clearly and avoid recommending code-level fixes that won't help.

Keep it under 500 words. Use markdown formatting. No preamble — start directly with the analysis.`;

export interface TrimmedResult {
  meta: AnalysisResult["meta"];
  summary: AnalysisResult["summary"];
  hotspots: AnalysisResult["hotspots"];
  totalHotspots: number;
  patterns: AnalysisResult["patterns"];
  totalPatterns: number;
  appBreakdown: AnalysisResult["appBreakdown"];
  tableBreakdown?: AnalysisResult["tableBreakdown"];
}

export function trimResultForPrompt(result: AnalysisResult): TrimmedResult {
  return {
    meta: result.meta,
    summary: result.summary,
    hotspots: result.hotspots.slice(0, config.explain.trimmedHotspots),
    totalHotspots: result.hotspots.length,
    patterns: result.patterns.slice(0, config.explain.trimmedPatterns),
    totalPatterns: result.patterns.length,
    appBreakdown: result.appBreakdown,
    tableBreakdown: result.tableBreakdown,
  };
}

export type ExplainModel = "sonnet" | "opus";

export const MODEL_IDS: Record<ExplainModel, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

export interface ExplainOptions {
  apiKey: string;
  model?: ExplainModel;
}

export interface AiDebugInfo {
  systemPrompt: string;
  userPayload: object;
  rawResponse: object;
}

export interface ExplainResult {
  text: string;
  cost: ApiCallCost;
  debugInfo: AiDebugInfo;
}

export async function explainAnalysis(
  result: AnalysisResult,
  options: ExplainOptions,
): Promise<ExplainResult> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const trimmed = trimResultForPrompt(result);
  const model = MODEL_IDS[options.model ?? config.defaultModel];

  const response = await client.messages.create({
    model,
    max_tokens: config.explain.maxTokens,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: JSON.stringify(trimmed, null, 2),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  let text = textBlock?.text ?? "";
  if (response.stop_reason === "max_tokens") {
    text += "\n\n*(Response truncated)*";
  }

  const cost = computeCallCost(
    "explain",
    model,
    response.usage.input_tokens,
    response.usage.output_tokens,
  );

  return {
    text,
    cost,
    debugInfo: {
      systemPrompt: SYSTEM_PROMPT,
      userPayload: trimmed,
      rawResponse: response,
    },
  };
}
