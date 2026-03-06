export interface AIFinding {
  title: string;
  category: "business-logic" | "cross-method" | "anomaly" | "code-fix";
  severity: "critical" | "warning" | "info";
  confidence: "high" | "medium" | "low";
  description: string;
  involvedMethods: string[];
  suggestion: string;
  codeFix?: string;
  evidence: string;
}
