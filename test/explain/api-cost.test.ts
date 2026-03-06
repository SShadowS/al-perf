import { describe, expect, test } from "bun:test";
import {
  computeCallCost,
  summarizeCosts,
  formatCallCost,
  formatCostSummary,
} from "../../src/explain/api-cost.js";

describe("computeCallCost", () => {
  test("sonnet pricing", () => {
    const cost = computeCallCost("explain", "claude-sonnet-4-6", 1_000_000, 1_000_000);
    // 1M input * $3/M + 1M output * $15/M = $18
    expect(cost.call).toBe("explain");
    expect(cost.model).toBe("claude-sonnet-4-6");
    expect(cost.inputTokens).toBe(1_000_000);
    expect(cost.outputTokens).toBe(1_000_000);
    expect(cost.cost).toBeCloseTo(18, 4);
  });

  test("opus pricing", () => {
    const cost = computeCallCost("deep", "claude-opus-4-6", 1_000_000, 1_000_000);
    // 1M input * $15/M + 1M output * $75/M = $90
    expect(cost.cost).toBeCloseTo(90, 4);
  });

  test("unknown model uses default (sonnet) pricing", () => {
    const cost = computeCallCost("test", "claude-future-model", 1_000_000, 1_000_000);
    expect(cost.cost).toBeCloseTo(18, 4);
  });

  test("small token counts produce fractional costs", () => {
    const cost = computeCallCost("explain", "claude-sonnet-4-6", 5000, 800);
    // 5000 * 3/1M + 800 * 15/1M = 0.015 + 0.012 = 0.027
    expect(cost.cost).toBeCloseTo(0.027, 6);
  });
});

describe("summarizeCosts", () => {
  test("aggregates multiple calls", () => {
    const calls = [
      computeCallCost("explain", "claude-sonnet-4-6", 4000, 800),
      computeCallCost("deep", "claude-sonnet-4-6", 8000, 1500),
    ];
    const summary = summarizeCosts(calls);
    expect(summary.calls).toHaveLength(2);
    expect(summary.totalInputTokens).toBe(12000);
    expect(summary.totalOutputTokens).toBe(2300);
    expect(summary.totalCost).toBeCloseTo(calls[0].cost + calls[1].cost, 6);
  });

  test("empty calls array produces zero totals", () => {
    const summary = summarizeCosts([]);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalCost).toBe(0);
  });
});

describe("formatCallCost", () => {
  test("formats a single call", () => {
    const cost = computeCallCost("explain", "claude-sonnet-4-6", 5000, 800);
    const formatted = formatCallCost(cost);
    expect(formatted).toBe("explain: 5000in/800out $0.0270");
  });
});

describe("formatCostSummary", () => {
  test("formats multiple calls with total", () => {
    const calls = [
      computeCallCost("explain", "claude-sonnet-4-6", 4000, 800),
      computeCallCost("deep", "claude-sonnet-4-6", 8000, 1500),
    ];
    const summary = summarizeCosts(calls);
    const formatted = formatCostSummary(summary);
    expect(formatted).toContain("explain: 4000in/800out");
    expect(formatted).toContain("deep: 8000in/1500out");
    expect(formatted).toContain("| total: 12000in/2300out");
  });
});
