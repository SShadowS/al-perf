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

interface TokenPrice {
	input: number;
	output: number;
}

/**
 * Sonnet 5's introductory pricing lapses at the start of 2026-09-01 UTC.
 *
 * Both rates are published, so the cutover is encoded rather than picked.
 * Hardcoding either one would be knowingly wrong on one side of a known date:
 * $3/$15 overstates every cost until then, $2/$10 understates every cost after.
 * This number is rendered to users as a dollar amount, so neither is acceptable.
 */
const SONNET_5_INTRO_ENDS_MS = Date.UTC(2026, 8, 1);

const SONNET_5_INTRO: TokenPrice = { input: 2, output: 10 };
const SONNET_5_STANDARD: TokenPrice = { input: 3, output: 15 };

/**
 * Pricing per million tokens — keep in sync with MODEL_IDS in explainer.ts.
 * Verified against Anthropic's published pricing on 2026-07-27.
 *
 * `hasExplicitPricing` is asserted over MODEL_IDS by a test, so a model id
 * bumped without a matching entry here fails the suite instead of silently
 * billing at the fallback rate and reporting a wrong figure.
 */
const PRICING: Record<string, TokenPrice> = {
	"claude-opus-5": { input: 5, output: 25 },
	// Sonnet 5 is resolved by date in `priceFor`, not from this map; the entry
	// exists so `hasExplicitPricing` and the fallback agree it is known.
	"claude-sonnet-5": SONNET_5_STANDARD,
	// Fallback for unknown models (uses Sonnet standard pricing)
	default: SONNET_5_STANDARD,
};

/** Whether a model id has its own pricing rather than falling back. */
export function hasExplicitPricing(model: string): boolean {
	return model !== "default" && model in PRICING;
}

function priceFor(model: string, at: Date): TokenPrice {
	if (model === "claude-sonnet-5") {
		return at.getTime() < SONNET_5_INTRO_ENDS_MS
			? SONNET_5_INTRO
			: SONNET_5_STANDARD;
	}
	return PRICING[model] ?? PRICING.default;
}

export function computeCallCost(
	call: string,
	model: string,
	inputTokens: number,
	outputTokens: number,
	/** Injectable for tests; a rate that changes on a date needs a clock. */
	at: Date = new Date(),
): ApiCallCost {
	const pricing = priceFor(model, at);
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
