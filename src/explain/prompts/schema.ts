import { CROSS_METHOD_PROMPT } from "./cross-method.js";
import { ANOMALY_PROMPT } from "./anomaly.js";
import { BUSINESS_LOGIC_PROMPT } from "./business-logic.js";
import { CODE_FIX_PROMPT } from "./code-fix.js";

export const AI_FINDINGS_SCHEMA = `## Output Format

You MUST respond with valid JSON matching this schema exactly. Do not include any text outside the JSON object.

\`\`\`json
{
  "findings": [
    {
      "category": "cross-method" | "anomaly" | "business-logic" | "code-fix",
      "title": "Short descriptive title of the finding",
      "description": "Detailed explanation of the issue, including evidence from the profile data",
      "impact": "high" | "medium" | "low",
      "confidence": "high" | "medium" | "low",
      "suggestion": "Specific, actionable recommendation. For code-fix category, include AL code snippets.",
      "relatedMethods": ["List of method identifiers involved in this finding"],
      "estimatedSavingsMs": null | number
    }
  ],
  "narrative": "A 2-4 paragraph markdown summary that tells the performance story. Start with the overall health assessment, then cover the most impactful findings, and end with prioritized next steps. This should read as a coherent narrative, not a list of findings."
}
\`\`\`

### Rules

1. Return 3-10 findings, ordered by impact (highest first).
2. Each finding must have a unique, specific title — not generic labels.
3. The \`confidence\` field reflects how certain you are about the finding: "high" means clear evidence in the data, "medium" means probable but could have alternative explanations, "low" means speculative or based on incomplete data.
4. The \`category\` must be one of: "cross-method", "anomaly", "business-logic", "code-fix".
5. \`estimatedSavingsMs\` should be null if you cannot reasonably estimate, otherwise provide a conservative estimate in milliseconds.
6. \`relatedMethods\` should use the method identifiers as they appear in the profile data (e.g., "CodeUnit.Sales-Post.PostSalesLine").
7. The \`narrative\` must be self-contained — a reader should understand the performance situation from the narrative alone without reading individual findings.
8. Do NOT repeat findings that the rule-based pattern detectors have already identified. Focus on insights that require understanding call tree relationships, domain context, or source code semantics.
`;

export interface BuildDeepSystemPromptOptions {
  hasSource: boolean;
}

export function buildDeepSystemPrompt(options: BuildDeepSystemPromptOptions): string {
  const intro = `You are a Business Central AL performance expert performing deep analysis. You are given structured profile analysis data including call tree structure and (optionally) source code of hotspot methods. Your job is to find performance issues that rule-based pattern detectors cannot express.`;

  const parts: string[] = [intro, CROSS_METHOD_PROMPT, ANOMALY_PROMPT];

  if (options.hasSource) {
    parts.push(BUSINESS_LOGIC_PROMPT);
    parts.push(CODE_FIX_PROMPT);
  }

  parts.push(AI_FINDINGS_SCHEMA);

  return parts.join("\n\n");
}
