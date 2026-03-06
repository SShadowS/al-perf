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
  // Strip markdown code fences if present
  let jsonStr = raw.trim();
  const fenceMatch = jsonStr.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray(parsed.findings) &&
      typeof parsed.narrative === "string"
    ) {
      const findings = parsed.findings.filter(isValidFinding);
      return { findings, narrative: parsed.narrative };
    }
    // Parsed JSON but wrong structure
    return { findings: [], narrative: raw };
  } catch {
    // JSON parse failed
    return { findings: [], narrative: raw };
  }
}
