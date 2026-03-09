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
      "title": "Short descriptive title of the finding",
      "category": "cross-method" | "anomaly" | "business-logic" | "code-fix",
      "severity": "critical" | "warning" | "info",
      "confidence": "high" | "medium" | "low",
      "description": "Detailed explanation of the issue",
      "involvedMethods": ["MethodA", "MethodB"],
      "suggestion": "Specific, actionable recommendation",
      "codeFix": "// Optional: AL code fix (only for code-fix category)",
      "evidence": "What data from the profile supports this finding"
    }
  ],
  "narrative": "A 2-4 paragraph markdown summary that tells the performance story. Start with the overall health assessment, then cover the most impactful findings, and end with prioritized next steps. This should read as a coherent narrative, not a list of findings."
}
\`\`\`

### Rules

1. Return 3-10 findings, ordered by severity (critical first).
2. Each finding must have a unique, specific title — not generic labels.
3. \`severity\`: "critical" = significant performance impact, "warning" = moderate concern, "info" = observation or suggestion.
4. \`confidence\`: "high" = clear evidence in the data, "medium" = probable but could have alternative explanations, "low" = speculative or based on incomplete data.
5. \`category\` must be one of: "cross-method", "anomaly", "business-logic", "code-fix".
6. \`involvedMethods\` should use method names as they appear in the profile data.
7. \`codeFix\` is optional — only include for "code-fix" category when you can provide concrete AL code.
8. \`evidence\` must reference specific data from the profile (times, hit counts, call relationships).
9. The \`narrative\` must be self-contained — a reader should understand the performance situation from the narrative alone without reading individual findings.
10. Do NOT repeat findings that the rule-based pattern detectors have already identified. Focus on insights that require understanding call tree relationships, domain context, or source code semantics.
`;

export interface PromptConfig {
  /** Hint about sqlPatterns/callGraph/astSummaries fields in the payload */
  dataAwareHints: boolean;
  /** Increase finding range from 3-10 to 5-15 */
  expandedFindings: boolean;
  /** Add cross-extension interaction analysis focus */
  crossExtensionFocus: boolean;
}

export const PROMPT_PRESETS: Record<string, PromptConfig> = {
  v1: {
    dataAwareHints: false,
    expandedFindings: false,
    crossExtensionFocus: false,
  },
  "+datahints": {
    dataAwareHints: true,
    expandedFindings: false,
    crossExtensionFocus: false,
  },
  "+morefindings": {
    dataAwareHints: false,
    expandedFindings: true,
    crossExtensionFocus: false,
  },
  "+crossext": {
    dataAwareHints: false,
    expandedFindings: false,
    crossExtensionFocus: true,
  },
  "+datahints+crossext": {
    dataAwareHints: true,
    expandedFindings: false,
    crossExtensionFocus: true,
  },
  "+all": {
    dataAwareHints: true,
    expandedFindings: true,
    crossExtensionFocus: true,
  },
};

const DATA_AWARE_HINTS = `## Payload Data Guide

The payload may include these optional structured data sections — use them to deepen your analysis:

- **sqlPatterns**: SQL queries grouped by table, with hit counts and self time. Use this to find redundant table access across different code paths, duplicate query shapes, and tables hit by multiple extensions.
- **callGraph**: Top methods as nodes with caller-callee edges. Use this to find fan-out patterns, redundant call paths reaching the same method, and unexpected cross-object dependencies.
- **astSummaries**: Static analysis of hotspot method bodies — loop counts, record ops, nesting depth, dangerous calls in loops. Use this to find methods with high structural complexity that correlate with high runtime cost.
`;

const CROSS_EXTENSION_FOCUS = `## Cross-Extension Interaction Analysis

Pay special attention to performance issues caused by interactions BETWEEN extensions (ISVs, per-tenant, and Base App):

- **Redundant work across extensions**: Multiple extensions subscribing to the same event and independently querying the same tables. Look for different objectIds accessing the same table in the call tree or SQL patterns.
- **Extension overhead on hot paths**: ISV extensions adding event subscribers to high-frequency Base App operations (e.g., per-line validation, per-record triggers). Small per-call overhead multiplied by high iteration counts.
- **Isolated Storage / Session State abuse**: Extensions using IsolatedStorage or single-instance codeunits for per-transaction state, causing unnecessary DB round-trips where in-memory state would suffice.
- **Extension-added JOINs**: ISV table extensions adding columns that cause implicit JOINs on high-frequency queries. Look for SetLoadFields opportunities to avoid loading extension fields.
`;

export interface BuildDeepSystemPromptOptions {
  hasSource: boolean;
  promptConfig?: PromptConfig;
}

export function buildDeepSystemPrompt(options: BuildDeepSystemPromptOptions): string {
  const intro = `You are a Business Central AL performance expert performing deep analysis. You are given structured profile analysis data including call tree structure and (optionally) source code of hotspot methods. Your job is to find performance issues that rule-based pattern detectors cannot express.`;

  const parts: string[] = [intro, CROSS_METHOD_PROMPT, ANOMALY_PROMPT];

  if (options.promptConfig?.dataAwareHints) {
    parts.push(DATA_AWARE_HINTS);
  }

  if (options.promptConfig?.crossExtensionFocus) {
    parts.push(CROSS_EXTENSION_FOCUS);
  }

  if (options.hasSource) {
    parts.push(BUSINESS_LOGIC_PROMPT);
    parts.push(CODE_FIX_PROMPT);
  }

  // Use expanded or standard finding count
  if (options.promptConfig?.expandedFindings) {
    parts.push(AI_FINDINGS_SCHEMA.replace(
      "Return 3-10 findings",
      "Return 5-15 findings",
    ));
  } else {
    parts.push(AI_FINDINGS_SCHEMA);
  }

  return parts.join("\n\n");
}
