export interface ApiCallCost {
  call: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface ApiCostSummary {
  calls: ApiCallCost[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

// Pricing per million tokens — keep in sync with MODEL_IDS in explainer.ts
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-6": { input: 15, output: 75 },
  // Fallback for unknown models (uses Sonnet pricing)
  default: { input: 3, output: 15 },
};

export function computeCallCost(
  call: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): ApiCallCost {
  const pricing = PRICING[model] ?? PRICING.default;
  const cost =
    (inputTokens * pricing.input) / 1_000_000 +
    (outputTokens * pricing.output) / 1_000_000;
  return { call, model, inputTokens, outputTokens, cost };
}

export function formatCallCost(c: ApiCallCost): string {
  return `${c.call}: ${c.inputTokens}in/${c.outputTokens}out $${c.cost.toFixed(4)}`;
}

export function formatCostSummary(summary: ApiCostSummary): string {
  const parts = summary.calls.map(formatCallCost).join(", ");
  return `${parts} | total: ${summary.totalInputTokens}in/${summary.totalOutputTokens}out $${summary.totalCost.toFixed(4)}`;
}

export function summarizeCosts(calls: ApiCallCost[]): ApiCostSummary {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  for (const c of calls) {
    totalInputTokens += c.inputTokens;
    totalOutputTokens += c.outputTokens;
    totalCost += c.cost;
  }
  return { calls, totalInputTokens, totalOutputTokens, totalCost };
}
