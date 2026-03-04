import type { MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern } from "../types/patterns.js";
import type { SourceIndex, RecordOpInfo, VariableInfo, TableFieldInfo } from "../types/source-index.js";
import { matchToSource } from "./locator.js";

/**
 * Check if a record operation targets a temporary variable.
 */
function isTemporaryOp(op: RecordOpInfo, variables: VariableInfo[]): boolean {
  if (!op.recordVariable) return false;
  const variable = variables.find(
    v => v.name.toLowerCase() === op.recordVariable!.toLowerCase()
  );
  return variable?.isTemporary === true;
}

/**
 * Format a method label for use in involvedMethods arrays.
 */
function methodLabel(m: MethodBreakdown): string {
  return `${m.functionName} (${m.objectType} ${m.objectId})`;
}

/** Aggregation CalcFormula types that cause full table scans */
const AGGREGATION_CALC_TYPES = new Set<TableFieldInfo["calcFormulaType"]>([
  "Sum", "Count", "Average", "Min", "Max", "Exist",
]);

/**
 * Determine CalcFields severity based on table's CalcFormula types.
 * Tables with Sum/Count/Average/Min/Max/Exist FlowFields → critical (aggregation = expensive).
 * Tables with only Lookup FlowFields → warning (single-row, less severe).
 * Unknown tables (not in source index) → critical (conservative default).
 */
function calcFieldSeverity(
  recordVariable: string | undefined,
  variables: VariableInfo[],
  index: SourceIndex,
): "critical" | "warning" {
  if (!recordVariable) return "critical";

  const variable = variables.find(
    v => v.name.toLowerCase() === recordVariable.toLowerCase()
  );
  if (!variable?.isRecord || !variable.tableName) return "critical";

  // Find the table in the source index by name
  for (const obj of index.objects.values()) {
    if (obj.objectType === "Table" && obj.objectName === variable.tableName) {
      const calcFields = obj.fields.filter(f => f.calcFormulaType);
      if (calcFields.length === 0) return "critical"; // No CalcFormula info, conservative
      const hasAggregation = calcFields.some(f => AGGREGATION_CALC_TYPES.has(f.calcFormulaType));
      return hasAggregation ? "critical" : "warning";
    }
  }

  return "critical"; // Table not found in index, conservative default
}

/**
 * Detect CalcFields/CalcSums inside loops.
 * Severity: critical for aggregation CalcFormulas (Sum/Count/Average), warning for Lookup-only.
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
      (op) => (op.type === "CalcFields" || op.type === "CalcSums") && !isTemporaryOp(op, match.features.variables),
    );

    for (const op of opsInLoop) {
      const severity = calcFieldSeverity(op.recordVariable, match.features.variables, index);
      const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
      patterns.push({
        id: "calcfields-in-loop",
        severity,
        title: `${op.type} inside loop in ${method.functionName}`,
        description: `${op.type}()${recVar} is called inside a loop at line ${op.line} in ${match.file}. Each iteration triggers a separate SQL query, causing N+1 query performance issues.`,
        impact: method.selfTime,
        involvedMethods: [methodLabel(method)],
        evidence: `${op.type}() at line ${op.line}, column ${op.column} inside loop`,
        suggestion: severity === "critical"
          ? "Move CalcFields() before the loop, or use SetLoadFields() to pre-load only the fields you need. This table has aggregation FlowFields (Sum/Count) which are especially expensive."
          : "Move CalcFields() before the loop, or use SetLoadFields(). This table has Lookup FlowFields which are less expensive but still cause N+1 queries.",
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
      (op) => (op.type === "Modify" || op.type === "ModifyAll") && !isTemporaryOp(op, match.features.variables),
    );

    for (const op of opsInLoop) {
      const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
      patterns.push({
        id: "modify-in-loop",
        severity: "critical",
        title: `${op.type} inside loop in ${method.functionName}`,
        description: `${op.type}()${recVar} is called inside a loop at line ${op.line} in ${match.file}. Each iteration issues a separate SQL UPDATE, which can be very slow for large datasets.`,
        impact: method.selfTime,
        involvedMethods: [methodLabel(method)],
        evidence: `${op.type}() at line ${op.line}, column ${op.column} inside loop`,
        suggestion: "Collect changes and apply them after the loop, or use ModifyAll() if applicable.",
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
      LOOKUP_OPS.has(op.type) && !isTemporaryOp(op, match.features.variables),
    );

    for (const op of opsInLoop) {
      const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
      patterns.push({
        id: "record-op-in-loop",
        severity: "critical",
        title: `${op.type} inside loop in ${method.functionName}`,
        description: `${op.type}()${recVar} is called inside a loop at line ${op.line} in ${match.file}. Each iteration triggers a separate SQL query.`,
        impact: method.selfTime,
        involvedMethods: [methodLabel(method)],
        evidence: `${op.type}() at line ${op.line}, column ${op.column} inside loop`,
        suggestion: "Restructure to reduce database calls inside the loop. Consider loading data before the loop with a single query.",
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
          suggestion: "Add SetLoadFields() before record retrieval to load only the fields you need, reducing I/O.",
        });
      }
    }
  }

  return patterns;
}

/**
 * Detect SetLoadFields that doesn't cover all fields later accessed.
 * Severity: critical (will cause runtime errors or wrong values).
 */
export function detectIncompleteSetLoadFields(
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

    const allOps = match.features.recordOps;
    const fieldAccesses = match.features.fieldAccesses;

    // Group SetLoadFields calls by record variable
    const loadFieldsByVar = new Map<string, Set<string>>();
    for (const op of allOps) {
      if (op.type === "SetLoadFields" && op.recordVariable) {
        const varLower = op.recordVariable.toLowerCase();
        if (!loadFieldsByVar.has(varLower)) {
          loadFieldsByVar.set(varLower, new Set());
        }
        if (op.allFieldArguments) {
          for (const f of op.allFieldArguments) {
            loadFieldsByVar.get(varLower)!.add(f.toLowerCase());
          }
        } else if (op.fieldArgument) {
          loadFieldsByVar.get(varLower)!.add(op.fieldArgument.toLowerCase());
        }
      }
    }

    // For each variable that has SetLoadFields, check if all accessed fields are covered
    for (const [varLower, loadedFields] of loadFieldsByVar) {
      const accessedFields = fieldAccesses
        .filter(a => a.recordVariable.toLowerCase() === varLower)
        .map(a => a.fieldName.toLowerCase());

      const uniqueAccessed = [...new Set(accessedFields)];
      const missingFields = uniqueAccessed.filter(f => !loadedFields.has(f));

      if (missingFields.length > 0) {
        const recVar = fieldAccesses.find(a => a.recordVariable.toLowerCase() === varLower)?.recordVariable ?? varLower;
        patterns.push({
          id: "incomplete-setloadfields",
          severity: "critical",
          title: `SetLoadFields on ${recVar} in ${method.functionName} is missing accessed fields`,
          description: `SetLoadFields() on ${recVar} loads [${[...loadedFields].join(", ")}] but the code later accesses [${missingFields.join(", ")}]. These fields will return default values or cause runtime errors.`,
          impact: method.selfTime,
          involvedMethods: [methodLabel(method)],
          evidence: `SetLoadFields loads ${loadedFields.size} field(s), but ${missingFields.length} additional field(s) are accessed: ${missingFields.join(", ")}`,
          suggestion: `Add the missing fields to SetLoadFields: ${missingFields.map(f => `"${f}"`).join(", ")}`,
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
    ...detectIncompleteSetLoadFields(methods, index),
  ];

  allPatterns.sort((a, b) => b.impact - a.impact);

  return allPatterns;
}
