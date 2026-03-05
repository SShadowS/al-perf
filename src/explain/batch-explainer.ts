import Anthropic from "@anthropic-ai/sdk";
import type { BatchAnalysisResult } from "../output/batch-types.js";
import type { ExplainModel, ExplainOptions } from "./explainer.js";
import { MODEL_IDS } from "./explainer.js";

export const BATCH_SYSTEM_PROMPT = `You are a Business Central performance analyst reviewing a batch of AL CPU profiles collected from the scheduled performance profiler. These profiles represent multiple user activities over a time window.

Your job is to identify systemic performance issues — patterns that recur across many sessions, methods that consistently dominate execution time, and actionable recommendations for the development team.

Focus on:
1. Recurring patterns — which issues appear across the most profiles? These are systemic, not one-off.
2. Cumulative hotspots — which methods consume the most total time across all sessions?
3. Activity breakdown — are certain activity types (web client, background jobs, web services) consistently slower?
4. Actionable recommendations — what should the team fix first for maximum impact?

Note: Profiles flagged as "selfReferential" captured the performance analyzer tool itself.
Deprioritize findings from these profiles and note this context when discussing them.

Be specific. Reference method names, object names, and pattern types. Prioritize by business impact.
Keep the analysis concise — under 500 words.`;

export interface TrimmedBatchResult {
  meta: BatchAnalysisResult["meta"];
  summary: BatchAnalysisResult["summary"];
  recurringPatterns: BatchAnalysisResult["recurringPatterns"];
  cumulativeHotspots: BatchAnalysisResult["cumulativeHotspots"];
  activityBreakdown: Array<{
    profilePath: string;
    healthScore: number;
    patternCount: { critical: number; warning: number; info: number };
    topHotspot: { functionName: string; objectName: string; selfTimePercent: number } | null;
    duration: number;
    metadata?: { activityDescription: string; activityType: string };
    selfReferential?: boolean;
  }>;
  appBreakdown: BatchAnalysisResult["appBreakdown"];
  errors: BatchAnalysisResult["errors"];
  totalHotspots: number;
  totalPatterns: number;
}

export function trimBatchResultForPrompt(result: BatchAnalysisResult): TrimmedBatchResult {
  return {
    meta: result.meta,
    summary: result.summary,
    recurringPatterns: result.recurringPatterns.slice(0, 15),
    cumulativeHotspots: result.cumulativeHotspots.slice(0, 20),
    activityBreakdown: result.activityBreakdown.slice(0, 20).map((a) => ({
      profilePath: a.profilePath,
      healthScore: a.healthScore,
      patternCount: a.patternCount,
      topHotspot: a.topHotspot,
      duration: a.duration,
      metadata: a.metadata
        ? { activityDescription: a.metadata.activityDescription, activityType: a.metadata.activityType }
        : undefined,
      ...(a.selfReferential ? { selfReferential: a.selfReferential } : {}),
    })),
    appBreakdown: result.appBreakdown.slice(0, 10),
    errors: result.errors,
    totalHotspots: result.cumulativeHotspots.length,
    totalPatterns: result.recurringPatterns.length,
  };
}

export async function explainBatchAnalysis(
  result: BatchAnalysisResult,
  options: ExplainOptions,
): Promise<string> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const trimmed = trimBatchResultForPrompt(result);
  const model = MODEL_IDS[options.model ?? "sonnet"];

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system: BATCH_SYSTEM_PROMPT,
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
  return text;
}
