import type { MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern } from "../types/patterns.js";
import type { SourceIndex, RecordOpInfo } from "../types/source-index.js";
import { matchToSource } from "./locator.js";

/**
 * Format a method label for use in involvedMethods arrays.
 */
function methodLabel(m: MethodBreakdown): string {
  return `${m.functionName} (${m.objectType} ${m.objectId})`;
}

/**
 * Detect CalcFields/CalcSums inside loops.
 * Severity: critical.
 */
export function detectCalcFieldsInLoop(
  methods: MethodBreakdown[],
  index: SourceIndex,
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  for (const method of methods) {
    const match = matchToSource(
      method.functionName,
      method.objectType,
      method.objectId,
      index,
    );
    if (!match) continue;

    const opsInLoop = match.features.recordOpsInLoops.filter(
      (op) => op.type === "CalcFields" || op.type === "CalcSums",
    );

    for (const op of opsInLoop) {
      const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
      patterns.push({
        id: "calcfields-in-loop",
        severity: "critical",
        title: `${op.type} inside loop in ${method.functionName}`,
        description: `${op.type}()${recVar} is called inside a loop at line ${op.line} in ${match.file}. Each iteration triggers a separate SQL query, causing N+1 query performance issues.`,
        impact: method.selfTime * method.hitCount,
        involvedMethods: [methodLabel(method)],
        evidence: `${op.type}() at line ${op.line}, column ${op.column} inside loop`,
      });
    }
  }

  return patterns;
}

/**
 * Detect Modify() inside loops.
 * Severity: critical.
 */
export function detectModifyInLoop(
  methods: MethodBreakdown[],
  index: SourceIndex,
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  for (const method of methods) {
    const match = matchToSource(
      method.functionName,
      method.objectType,
      method.objectId,
      index,
    );
    if (!match) continue;

    const opsInLoop = match.features.recordOpsInLoops.filter(
      (op) => op.type === "Modify" || op.type === "ModifyAll",
    );

    for (const op of opsInLoop) {
      const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
      patterns.push({
        id: "modify-in-loop",
        severity: "critical",
        title: `${op.type} inside loop in ${method.functionName}`,
        description: `${op.type}()${recVar} is called inside a loop at line ${op.line} in ${match.file}. Each iteration issues a separate SQL UPDATE, which can be very slow for large datasets.`,
        impact: method.selfTime * method.hitCount,
        involvedMethods: [methodLabel(method)],
        evidence: `${op.type}() at line ${op.line}, column ${op.column} inside loop`,
      });
    }
  }

  return patterns;
}

/**
 * Detect record lookup operations (FindSet/FindFirst/FindLast/Find/Get) inside loops.
 * Severity: critical.
 */
export function detectRecordOpInLoop(
  methods: MethodBreakdown[],
  index: SourceIndex,
): DetectedPattern[] {
  const LOOKUP_OPS = new Set(["FindSet", "FindFirst", "FindLast", "Find", "Get"]);
  const patterns: DetectedPattern[] = [];

  for (const method of methods) {
    const match = matchToSource(
      method.functionName,
      method.objectType,
      method.objectId,
      index,
    );
    if (!match) continue;

    const opsInLoop = match.features.recordOpsInLoops.filter((op) =>
      LOOKUP_OPS.has(op.type),
    );

    for (const op of opsInLoop) {
      const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
      patterns.push({
        id: "record-op-in-loop",
        severity: "critical",
        title: `${op.type} inside loop in ${method.functionName}`,
        description: `${op.type}()${recVar} is called inside a loop at line ${op.line} in ${match.file}. Each iteration triggers a separate SQL query.`,
        impact: method.selfTime * method.hitCount,
        involvedMethods: [methodLabel(method)],
        evidence: `${op.type}() at line ${op.line}, column ${op.column} inside loop`,
      });
    }
  }

  return patterns;
}

/**
 * Detect FindSet/FindFirst/FindLast without a preceding SetLoadFields on the same record variable.
 * Severity: warning.
 */
export function detectMissingSetLoadFields(
  methods: MethodBreakdown[],
  index: SourceIndex,
): DetectedPattern[] {
  const FIND_OPS = new Set(["FindSet", "FindFirst", "FindLast"]);
  const patterns: DetectedPattern[] = [];

  for (const method of methods) {
    const match = matchToSource(
      method.functionName,
      method.objectType,
      method.objectId,
      index,
    );
    if (!match) continue;

    const allOps = match.features.recordOps;
    const findOps = allOps.filter((op) => FIND_OPS.has(op.type));

    // Collect all record variables that have SetLoadFields
    const setLoadFieldsVars = new Set<string>();
    for (const op of allOps) {
      if (op.type === "SetLoadFields" && op.recordVariable) {
        setLoadFieldsVars.add(op.recordVariable.toLowerCase());
      }
    }

    for (const op of findOps) {
      const recVarLower = op.recordVariable?.toLowerCase() ?? "";
      if (!setLoadFieldsVars.has(recVarLower)) {
        const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
        patterns.push({
          id: "missing-setloadfields",
          severity: "warning",
          title: `${op.type} without SetLoadFields in ${method.functionName}`,
          description: `${op.type}()${recVar} at line ${op.line} in ${match.file} has no preceding SetLoadFields(). This loads all fields from the database when only a subset may be needed.`,
          impact: method.selfTime,
          involvedMethods: [methodLabel(method)],
          evidence: `${op.type}() at line ${op.line} without SetLoadFields for ${op.recordVariable ?? "unknown variable"}`,
        });
      }
    }
  }

  return patterns;
}

/**
 * Run all source-correlated pattern detectors and return results sorted by impact descending.
 */
export function runSourceDetectors(
  methods: MethodBreakdown[],
  index: SourceIndex,
): DetectedPattern[] {
  const allPatterns: DetectedPattern[] = [
    ...detectCalcFieldsInLoop(methods, index),
    ...detectModifyInLoop(methods, index),
    ...detectRecordOpInLoop(methods, index),
    ...detectMissingSetLoadFields(methods, index),
  ];

  allPatterns.sort((a, b) => b.impact - a.impact);

  return allPatterns;
}
