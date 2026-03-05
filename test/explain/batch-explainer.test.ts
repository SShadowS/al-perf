import { describe, it, expect } from "bun:test";
import { trimBatchResultForPrompt, BATCH_SYSTEM_PROMPT } from "../../src/explain/batch-explainer.js";
import type { BatchAnalysisResult } from "../../src/output/batch-types.js";

describe("batch explainer", () => {
  it("trims batch result to stay within token budget", () => {
    const result = {
      meta: { profileCount: 2, timeRange: null, totalDuration: 1000000, activityTypes: {}, analyzedAt: "", sourceAvailable: false },
      summary: { oneLiner: "test", overallHealthScore: 50, worstProfile: null, totalPatternCount: { critical: 1, warning: 2, info: 0 } },
      recurringPatterns: [],
      cumulativeHotspots: [],
      activityBreakdown: [],
      appBreakdown: [],
      profiles: [],
      errors: [],
    } satisfies BatchAnalysisResult;

    const trimmed = trimBatchResultForPrompt(result);

    expect(trimmed).not.toHaveProperty("profiles");
    expect(trimmed).toHaveProperty("meta");
    expect(trimmed).toHaveProperty("recurringPatterns");
    expect(trimmed).toHaveProperty("totalHotspots");
    expect(trimmed).toHaveProperty("totalPatterns");
  });

  it("has a system prompt focused on aggregate analysis", () => {
    expect(BATCH_SYSTEM_PROMPT).toContain("batch");
    expect(BATCH_SYSTEM_PROMPT).toContain("Recurring");
    expect(BATCH_SYSTEM_PROMPT).toContain("systemic");
  });

  it("limits trimmed arrays to reasonable sizes", () => {
    const manyPatterns = Array.from({ length: 30 }, (_, i) => ({
      id: `pattern-${i}`,
      severity: "warning" as const,
      title: `Pattern ${i}`,
      profileCount: 5,
      totalProfiles: 10,
      recurrencePercent: 50,
      affectedActivities: ["test"],
    }));

    const result = {
      meta: { profileCount: 10, timeRange: null, totalDuration: 1000000, activityTypes: {}, analyzedAt: "", sourceAvailable: false },
      summary: { oneLiner: "test", overallHealthScore: 50, worstProfile: null, totalPatternCount: { critical: 0, warning: 30, info: 0 } },
      recurringPatterns: manyPatterns,
      cumulativeHotspots: [],
      activityBreakdown: [],
      appBreakdown: [],
      profiles: [],
      errors: [],
    } satisfies BatchAnalysisResult;

    const trimmed = trimBatchResultForPrompt(result);

    expect(trimmed.recurringPatterns).toHaveLength(15);
    expect(trimmed.totalPatterns).toBe(30);
  });
});
