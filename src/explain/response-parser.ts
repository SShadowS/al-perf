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

export function parseDeepResponse(raw: string): DeepAnalysisResponse {
  // Strip markdown code fences if present (flexible matching)
  let jsonStr = raw.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Also try extracting the first { ... } block if the above didn't yield valid JSON
  const tryParse = (str: string): unknown | null => {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  };

  let parsed = tryParse(jsonStr);

  // If that failed, try extracting from first { to last }
  if (parsed === null) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      parsed = tryParse(raw.slice(start, end + 1));
    }
  }

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

  // Could not parse structured response — treat entire text as narrative
  return { findings: [], narrative: raw };
}
