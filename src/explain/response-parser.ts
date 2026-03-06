import type { AIFinding } from "../types/ai-findings.js";

export interface DeepAnalysisResponse {
  findings: AIFinding[];
  narrative: string;
}

const VALID_CATEGORIES = new Set([
  "business-logic",
  "cross-method",
  "anomaly",
  "code-fix",
]);
const VALID_SEVERITIES = new Set(["critical", "warning", "info"]);
const VALID_CONFIDENCES = new Set(["high", "medium", "low"]);

function isValidFinding(f: unknown): f is AIFinding {
  if (typeof f !== "object" || f === null) return false;
  const obj = f as Record<string, unknown>;
  return (
    typeof obj.title === "string" &&
    typeof obj.category === "string" &&
    VALID_CATEGORIES.has(obj.category) &&
    typeof obj.severity === "string" &&
    VALID_SEVERITIES.has(obj.severity) &&
    typeof obj.confidence === "string" &&
    VALID_CONFIDENCES.has(obj.confidence) &&
    typeof obj.description === "string" &&
    Array.isArray(obj.involvedMethods) &&
    typeof obj.suggestion === "string" &&
    typeof obj.evidence === "string" &&
    (obj.codeFix === undefined || typeof obj.codeFix === "string")
  );
}

function tryParse(str: string): unknown | null {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function extractJsonContent(raw: string): string {
  // Strip markdown code fences if present (flexible matching)
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Strip leading fences without closing (truncated response)
  const openFence = raw.match(/^```(?:json)?\s*\n([\s\S]*)$/);
  if (openFence) return openFence[1].trim();

  return raw.trim();
}

/**
 * Salvage individual finding objects from truncated JSON.
 * Looks for complete {...} blocks that match the finding structure.
 */
function salvageTruncatedFindings(text: string): AIFinding[] {
  const findings: AIFinding[] = [];
  // Match complete JSON objects at the finding level
  const objectPattern = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let match;
  while ((match = objectPattern.exec(text)) !== null) {
    const candidate = tryParse(match[0]);
    if (candidate && isValidFinding(candidate)) {
      findings.push(candidate);
    }
  }
  return findings;
}

function extractStructuredResult(parsed: unknown): DeepAnalysisResponse | null {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>).findings) &&
    typeof (parsed as Record<string, unknown>).narrative === "string"
  ) {
    const obj = parsed as { findings: unknown[]; narrative: string };
    const findings = obj.findings.filter(isValidFinding);
    return { findings, narrative: obj.narrative };
  }
  return null;
}

export function parseDeepResponse(raw: string): DeepAnalysisResponse {
  const jsonStr = extractJsonContent(raw);

  // Try parsing the extracted content directly
  let parsed = tryParse(jsonStr);
  let result = parsed ? extractStructuredResult(parsed) : null;
  if (result) return result;

  // Try extracting from first { to last }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    parsed = tryParse(raw.slice(start, end + 1));
    result = parsed ? extractStructuredResult(parsed) : null;
    if (result) return result;
  }

  // JSON is likely truncated — salvage individual complete findings
  const salvaged = salvageTruncatedFindings(jsonStr);
  if (salvaged.length > 0) {
    return {
      findings: salvaged,
      narrative: "*(AI analysis was truncated — showing salvaged findings)*",
    };
  }

  // Could not parse structured response — treat entire text as narrative
  return { findings: [], narrative: raw };
}
