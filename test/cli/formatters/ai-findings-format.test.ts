import { describe, test, expect } from "bun:test";
import { analyzeProfile } from "../../../src/core/analyzer.js";
import { formatAnalysisTerminal } from "../../../src/cli/formatters/terminal.js";
import { formatAnalysisJson } from "../../../src/cli/formatters/json.js";
import { formatAnalysisMarkdown } from "../../../src/cli/formatters/markdown.js";
import { formatAnalysisHtml } from "../../../src/cli/formatters/html.js";
import type { AnalysisResult } from "../../../src/output/types.js";
import type { AIFinding } from "../../../src/types/ai-findings.js";

const FIXTURES = "test/fixtures";

const sampleFindings: AIFinding[] = [
  {
    title: "Redundant Record Fetching",
    category: "cross-method",
    severity: "warning",
    confidence: "high",
    description: "Multiple methods fetch the same Customer record without caching.",
    involvedMethods: ["GetCustomer", "ValidateCustomer"],
    suggestion: "Cache the Customer record in a local variable.",
    evidence: "GetCustomer is called 15 times with identical filters.",
    codeFix: 'local CustomerRec: Record "Customer";\nif not CustomerRec.Get(CustomerNo) then\n  exit;',
  },
  {
    title: "Anomalous Spike in OnInsert",
    category: "anomaly",
    severity: "critical",
    confidence: "medium",
    description: "OnInsert trigger takes 3x longer than expected.",
    involvedMethods: ["OnInsert"],
    suggestion: "Review event subscribers on the Insert trigger.",
    evidence: "Self time is 450ms vs 150ms baseline.",
  },
];

const sampleNarrative = "This profile reveals two main concerns: redundant record fetching and an anomalous spike in insert operations.";

async function makeResultWithAI(): Promise<AnalysisResult> {
  const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
  result.aiFindings = sampleFindings;
  result.aiNarrative = sampleNarrative;
  return result;
}

describe("AI findings in terminal formatter", () => {
  test("includes AI Findings section with finding titles", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisTerminal(result);
    expect(output).toContain("AI Findings");
    expect(output).toContain("Redundant Record Fetching");
    expect(output).toContain("Anomalous Spike in OnInsert");
  });

  test("includes AI Narrative section", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisTerminal(result);
    expect(output).toContain("AI Narrative");
    expect(output).toContain("redundant record fetching");
  });

  test("includes severity and confidence", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisTerminal(result);
    expect(output).toContain("high confidence");
    expect(output).toContain("medium confidence");
  });

  test("includes category", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisTerminal(result);
    expect(output).toContain("cross-method");
    expect(output).toContain("anomaly");
  });

  test("includes code fix when present", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisTerminal(result);
    expect(output).toContain("CustomerRec");
  });
});

describe("AI findings in JSON formatter", () => {
  test("includes aiFindings array when parsed", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisJson(result);
    const parsed = JSON.parse(output);
    expect(parsed.aiFindings).toBeArrayOfSize(2);
    expect(parsed.aiFindings[0].title).toBe("Redundant Record Fetching");
    expect(parsed.aiFindings[1].severity).toBe("critical");
  });

  test("includes aiNarrative when parsed", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisJson(result);
    const parsed = JSON.parse(output);
    expect(parsed.aiNarrative).toBe(sampleNarrative);
  });
});

describe("AI findings in markdown formatter", () => {
  test("includes AI Findings section", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisMarkdown(result);
    expect(output).toContain("## AI Findings");
    expect(output).toContain("Redundant Record Fetching");
    expect(output).toContain("Anomalous Spike in OnInsert");
  });

  test("includes AI Narrative section", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisMarkdown(result);
    expect(output).toContain("## AI Narrative");
    expect(output).toContain(sampleNarrative);
  });

  test("renders codeFix in fenced AL code block", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisMarkdown(result);
    expect(output).toContain("```al");
    expect(output).toContain("CustomerRec");
  });
});

describe("AI findings in HTML formatter", () => {
  test("includes AI Findings section", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisHtml(result);
    expect(output).toContain("AI Findings");
    expect(output).toContain("Redundant Record Fetching");
  });

  test("includes AI Narrative section", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisHtml(result);
    expect(output).toContain("AI Narrative");
  });

  test("renders codeFix in pre/code block", async () => {
    const result = await makeResultWithAI();
    const output = formatAnalysisHtml(result);
    expect(output).toContain("<pre><code");
    expect(output).toContain("CustomerRec");
  });
});

describe("no AI sections when absent", () => {
  test("terminal omits AI sections when aiFindings is undefined", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisTerminal(result);
    expect(output).not.toContain("AI Findings");
    expect(output).not.toContain("AI Narrative");
  });

  test("markdown omits AI sections when aiFindings is undefined", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisMarkdown(result);
    expect(output).not.toContain("## AI Findings");
    expect(output).not.toContain("## AI Narrative");
  });

  test("HTML omits AI sections when aiFindings is undefined", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    expect(output).not.toContain("AI Findings");
    expect(output).not.toContain("AI Narrative");
  });

  test("JSON omits aiFindings key when undefined", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisJson(result);
    const parsed = JSON.parse(output);
    expect(parsed.aiFindings).toBeUndefined();
    expect(parsed.aiNarrative).toBeUndefined();
  });
});
