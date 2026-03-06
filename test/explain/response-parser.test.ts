import { describe, expect, test } from "bun:test";
import { parseDeepResponse } from "../../src/explain/response-parser.js";

const validFinding = {
  title: "Excessive table reads in loop",
  category: "business-logic",
  severity: "critical",
  confidence: "high",
  description: "FindSet called inside a loop body",
  involvedMethods: ["ProcessLines", "GetRecord"],
  suggestion: "Move the query outside the loop",
  evidence: "Method ProcessLines calls GetRecord 500 times",
};

describe("parseDeepResponse", () => {
  test("valid JSON — parses correctly, extracts findings and narrative", () => {
    const raw = JSON.stringify({
      findings: [validFinding],
      narrative: "The profile shows a hot loop.",
    });
    const result = parseDeepResponse(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("Excessive table reads in loop");
    expect(result.narrative).toBe("The profile shows a hot loop.");
  });

  test("JSON in code fence is handled", () => {
    const inner = JSON.stringify({
      findings: [validFinding],
      narrative: "Fenced narrative.",
    });
    const raw = "```json\n" + inner + "\n```";
    const result = parseDeepResponse(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.narrative).toBe("Fenced narrative.");
  });

  test("malformed JSON falls back to narrative-only", () => {
    const raw = "This is just plain text, not JSON at all.";
    const result = parseDeepResponse(raw);
    expect(result.findings).toHaveLength(0);
    expect(result.narrative).toBe(raw);
  });

  test("invalid categories are filtered out, valid ones kept", () => {
    const raw = JSON.stringify({
      findings: [
        validFinding,
        { ...validFinding, category: "not-a-real-category" },
        { ...validFinding, title: "Anomaly detected", category: "anomaly" },
      ],
      narrative: "Mixed findings.",
    });
    const result = parseDeepResponse(raw);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].category).toBe("business-logic");
    expect(result.findings[1].category).toBe("anomaly");
  });

  test("codeFix is preserved when present", () => {
    const findingWithFix = {
      ...validFinding,
      codeFix: 'Record.SetLoadFields("No.", "Name");',
    };
    const raw = JSON.stringify({
      findings: [findingWithFix],
      narrative: "Has a code fix.",
    });
    const result = parseDeepResponse(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].codeFix).toBe(
      'Record.SetLoadFields("No.", "Name");'
    );
  });

  test("empty findings array works", () => {
    const raw = JSON.stringify({
      findings: [],
      narrative: "Nothing notable found.",
    });
    const result = parseDeepResponse(raw);
    expect(result.findings).toHaveLength(0);
    expect(result.narrative).toBe("Nothing notable found.");
  });

  test("missing narrative field falls back to raw text", () => {
    const raw = JSON.stringify({
      findings: [validFinding],
    });
    const result = parseDeepResponse(raw);
    expect(result.findings).toHaveLength(0);
    expect(result.narrative).toBe(raw);
  });

  test("JSON embedded in surrounding text is extracted", () => {
    const json = JSON.stringify({
      findings: [validFinding],
      narrative: "Embedded narrative.",
    });
    const raw = "Here is my analysis:\n\n" + json + "\n\nHope this helps!";
    const result = parseDeepResponse(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.narrative).toBe("Embedded narrative.");
  });

  test("code fence with extra whitespace is handled", () => {
    const inner = JSON.stringify({
      findings: [validFinding],
      narrative: "Whitespace fenced.",
    });
    const raw = "```json\n" + inner + "\n  ```\n";
    const result = parseDeepResponse(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.narrative).toBe("Whitespace fenced.");
  });
});
