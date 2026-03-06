import { describe, expect, test } from "bun:test";
import { CROSS_METHOD_PROMPT } from "../../../src/explain/prompts/cross-method.js";
import { ANOMALY_PROMPT } from "../../../src/explain/prompts/anomaly.js";
import { BUSINESS_LOGIC_PROMPT } from "../../../src/explain/prompts/business-logic.js";
import { CODE_FIX_PROMPT } from "../../../src/explain/prompts/code-fix.js";
import {
  AI_FINDINGS_SCHEMA,
  buildDeepSystemPrompt,
} from "../../../src/explain/prompts/schema.js";

describe("prompt modules", () => {
  test("CROSS_METHOD_PROMPT is a non-empty string (>50 chars)", () => {
    expect(typeof CROSS_METHOD_PROMPT).toBe("string");
    expect(CROSS_METHOD_PROMPT.length).toBeGreaterThan(50);
  });

  test("ANOMALY_PROMPT is a non-empty string (>50 chars)", () => {
    expect(typeof ANOMALY_PROMPT).toBe("string");
    expect(ANOMALY_PROMPT.length).toBeGreaterThan(50);
  });

  test("BUSINESS_LOGIC_PROMPT is a non-empty string (>50 chars)", () => {
    expect(typeof BUSINESS_LOGIC_PROMPT).toBe("string");
    expect(BUSINESS_LOGIC_PROMPT.length).toBeGreaterThan(50);
  });

  test("CODE_FIX_PROMPT is a non-empty string (>50 chars)", () => {
    expect(typeof CODE_FIX_PROMPT).toBe("string");
    expect(CODE_FIX_PROMPT.length).toBeGreaterThan(50);
  });

  test("AI_FINDINGS_SCHEMA is a non-empty string (>50 chars)", () => {
    expect(typeof AI_FINDINGS_SCHEMA).toBe("string");
    expect(AI_FINDINGS_SCHEMA.length).toBeGreaterThan(50);
  });

  test("AI_FINDINGS_SCHEMA mentions required fields matching AIFinding type", () => {
    expect(AI_FINDINGS_SCHEMA).toContain("findings");
    expect(AI_FINDINGS_SCHEMA).toContain("narrative");
    expect(AI_FINDINGS_SCHEMA).toContain("category");
    expect(AI_FINDINGS_SCHEMA).toContain("confidence");
    expect(AI_FINDINGS_SCHEMA).toContain("severity");
    expect(AI_FINDINGS_SCHEMA).toContain("involvedMethods");
    expect(AI_FINDINGS_SCHEMA).toContain("evidence");
    expect(AI_FINDINGS_SCHEMA).toContain("codeFix");
  });
});

describe("buildDeepSystemPrompt", () => {
  test("without source includes cross-method and anomaly but not code-fix content", () => {
    const prompt = buildDeepSystemPrompt({ hasSource: false });

    // Should include base intro
    expect(prompt).toContain(
      "You are a Business Central AL performance expert performing deep analysis",
    );

    // Should include cross-method content
    expect(prompt).toContain("Expensive Call Chains");
    expect(prompt).toContain("Fan-Out Patterns");
    expect(prompt).toContain("Event Cascade Overhead");

    // Should include anomaly content
    expect(prompt).toContain("Typical Performance Envelopes");
    expect(prompt).toContain("Environmental Signatures");

    // Should include schema
    expect(prompt).toContain("findings");
    expect(prompt).toContain("narrative");

    // Should NOT include source-dependent content
    expect(prompt).not.toContain("CalcFields in Loop");
    expect(prompt).not.toContain("AL Code Fix Templates");
    expect(prompt).not.toContain("Deferrable Work");
    expect(prompt).not.toContain("Business Logic Analysis");
  });

  test("with source includes all sections", () => {
    const prompt = buildDeepSystemPrompt({ hasSource: true });

    // Should include base intro
    expect(prompt).toContain(
      "You are a Business Central AL performance expert performing deep analysis",
    );

    // Should include cross-method content
    expect(prompt).toContain("Expensive Call Chains");
    expect(prompt).toContain("Fan-Out Patterns");

    // Should include anomaly content
    expect(prompt).toContain("Typical Performance Envelopes");

    // Should include business-logic content
    expect(prompt).toContain("Deferrable Work");
    expect(prompt).toContain("Redundant Per-Record Validation");
    expect(prompt).toContain("Over-Fetching Beyond SetLoadFields");

    // Should include code-fix content
    expect(prompt).toContain("CalcFields in Loop");
    expect(prompt).toContain("Missing SetLoadFields");
    expect(prompt).toContain("Modify in Loop");
    expect(prompt).toContain("FindSet in Loop");
    expect(prompt).toContain("AL Code Fix Templates");

    // Should include schema
    expect(prompt).toContain("findings");
    expect(prompt).toContain("narrative");
  });
});
