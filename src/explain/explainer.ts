import Anthropic from "@anthropic-ai/sdk";
import type { AnalysisResult } from "../output/types.js";

export const SYSTEM_PROMPT = `You are a Business Central AL performance expert. You are given the JSON output of a profile analysis. Write a concise, actionable summary covering:

1. What the profile captured (type, duration, scale)
2. The main performance story — identify the dominant call chains and explain WHY they're slow, not just that they are
3. Group related patterns by root cause instead of listing them individually (e.g. "ApplyItemLedgEntry has 15 record ops in loops" not 15 separate findings)
4. App breakdown — which extensions are responsible
5. Top 2-3 concrete recommendations, prioritized by impact

Keep it under 500 words. Use markdown formatting. No preamble — start directly with the analysis.`;

export interface TrimmedResult {
  meta: AnalysisResult["meta"];
  summary: AnalysisResult["summary"];
  hotspots: AnalysisResult["hotspots"];
  totalHotspots: number;
  patterns: AnalysisResult["patterns"];
  totalPatterns: number;
  appBreakdown: AnalysisResult["appBreakdown"];
}

export function trimResultForPrompt(result: AnalysisResult): TrimmedResult {
  return {
    meta: result.meta,
    summary: result.summary,
    hotspots: result.hotspots.slice(0, 10),
    totalHotspots: result.hotspots.length,
    patterns: result.patterns.slice(0, 15),
    totalPatterns: result.patterns.length,
    appBreakdown: result.appBreakdown,
  };
}

export type ExplainModel = "sonnet" | "opus";

const MODEL_IDS: Record<ExplainModel, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

export interface ExplainOptions {
  apiKey: string;
  model?: ExplainModel;
}

export async function explainAnalysis(
  result: AnalysisResult,
  options: ExplainOptions,
): Promise<string> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const trimmed = trimResultForPrompt(result);
  const model = MODEL_IDS[options.model ?? "sonnet"];

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: JSON.stringify(trimmed, null, 2),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text ?? "";
}
