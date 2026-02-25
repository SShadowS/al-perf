import type { DetectedPattern } from "../types/patterns.js";
import type { SourceIndex, ProcedureInfo, TriggerInfo } from "../types/source-index.js";

/**
 * Format a member label for use in involvedMethods arrays.
 */
function memberLabel(member: ProcedureInfo | TriggerInfo): string {
  return `${member.name} (${member.objectType} ${member.objectId})`;
}

/**
 * Detect nested loops (a loop inside another loop).
 * Uses lineStart/lineEnd ranges to determine containment.
 * Severity: warning.
 */
export function detectNestedLoops(index: SourceIndex): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  for (const obj of index.objects.values()) {
    const allMembers = [...obj.procedures, ...obj.triggers];
    for (const member of allMembers) {
      const loops = member.features.loops;
      if (loops.length < 2) continue;

      const reported = new Set<number>();
      for (const outer of loops) {
        for (const inner of loops) {
          if (inner === outer) continue;
          if (reported.has(inner.lineStart)) continue;
          if (inner.lineStart > outer.lineStart && inner.lineEnd <= outer.lineEnd) {
            reported.add(inner.lineStart);
            patterns.push({
              id: "nested-loops",
              severity: "warning",
              title: `Nested ${inner.type} loop inside ${outer.type} loop in ${member.name}`,
              description: `A ${inner.type} loop (line ${inner.lineStart}) is nested inside a ${outer.type} loop (line ${outer.lineStart}) in ${member.file}. Nested loops multiply iteration counts and can cause severe performance degradation.`,
              impact: 0,
              involvedMethods: [memberLabel(member)],
              evidence: `${inner.type} loop at line ${inner.lineStart}-${inner.lineEnd} inside ${outer.type} loop at line ${outer.lineStart}-${outer.lineEnd}`,
              suggestion: "Consider restructuring to avoid nested loops. Pre-load inner data before the outer loop, or use bulk operations.",
            });
          }
        }
      }
    }
  }

  return patterns;
}

/**
 * Detect FindSet/FindFirst/FindLast without any preceding SetRange/SetFilter
 * on the same record variable within the same procedure.
 * Severity: warning.
 */
export function detectUnfilteredFindSet(index: SourceIndex): DetectedPattern[] {
  const FIND_OPS = new Set(["FindSet", "FindFirst", "FindLast"]);
  const FILTER_OPS = new Set(["SetRange", "SetFilter"]);
  const patterns: DetectedPattern[] = [];

  for (const obj of index.objects.values()) {
    const allMembers = [...obj.procedures, ...obj.triggers];
    for (const member of allMembers) {
      const ops = member.features.recordOps;
      const findOps = ops.filter((op) => FIND_OPS.has(op.type));

      // Collect all record variables that have SetRange or SetFilter
      const filteredVars = new Set<string>();
      for (const op of ops) {
        if (FILTER_OPS.has(op.type) && op.recordVariable) {
          filteredVars.add(op.recordVariable.toLowerCase());
        }
      }

      for (const op of findOps) {
        const varLower = op.recordVariable?.toLowerCase() ?? "";
        if (varLower && !filteredVars.has(varLower)) {
          patterns.push({
            id: "unfiltered-findset",
            severity: "warning",
            title: `${op.type} without filters on ${op.recordVariable} in ${member.name}`,
            description: `${op.type}() on ${op.recordVariable} at line ${op.line} in ${member.file} has no preceding SetRange() or SetFilter(). This queries all records in the table, which can be extremely slow on large tables.`,
            impact: 0,
            involvedMethods: [memberLabel(member)],
            evidence: `${op.type}() at line ${op.line} on ${op.recordVariable} with no SetRange/SetFilter`,
            suggestion: "Add SetRange() or SetFilter() before the record retrieval to limit the result set. Querying entire tables causes full table scans.",
          });
        }
      }
    }
  }

  return patterns;
}

/**
 * Detect event subscriber procedures that have complex features (loops, many record ops).
 * Event subscribers are implicit call points that are easy to overlook.
 * Severity: info (warning if they contain record ops in loops).
 */
export function detectEventSubscriberIssues(index: SourceIndex): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  for (const obj of index.objects.values()) {
    for (const proc of obj.procedures) {
      if (!proc.isEventSubscriber) continue;

      const hasLoops = proc.features.loops.length > 0;
      const hasRecordOpsInLoops = proc.features.recordOpsInLoops.length > 0;

      if (hasRecordOpsInLoops) {
        patterns.push({
          id: "event-subscriber-with-loop-ops",
          severity: "warning",
          title: `Event subscriber ${proc.name} has record operations inside loops`,
          description: `Event subscriber ${proc.name} in ${proc.file} (line ${proc.lineStart}) contains ${proc.features.recordOpsInLoops.length} record operation(s) inside loops. Event subscribers are called implicitly and their performance impact is easy to overlook.`,
          impact: 0,
          involvedMethods: [memberLabel(proc)],
          evidence: `${proc.features.recordOpsInLoops.length} record op(s) in loops within event subscriber`,
          suggestion: "Review this event subscriber for performance impact. Consider batching operations or reducing work done inside loops.",
        });
      } else if (hasLoops) {
        patterns.push({
          id: "event-subscriber-with-loops",
          severity: "info",
          title: `Event subscriber ${proc.name} contains loops`,
          description: `Event subscriber ${proc.name} in ${proc.file} (line ${proc.lineStart}) contains ${proc.features.loops.length} loop(s). Event subscribers are called implicitly for every event invocation.`,
          impact: 0,
          involvedMethods: [memberLabel(proc)],
          evidence: `${proc.features.loops.length} loop(s) in event subscriber`,
          suggestion: "Ensure loop iterations are bounded and consider whether this subscriber needs to run for every event invocation.",
        });
      }
    }
  }

  return patterns;
}

/**
 * Run all source-only pattern detectors and return results sorted by impact descending.
 */
export function runSourceOnlyDetectors(index: SourceIndex): DetectedPattern[] {
  const allPatterns: DetectedPattern[] = [
    ...detectNestedLoops(index),
    ...detectUnfilteredFindSet(index),
    ...detectEventSubscriberIssues(index),
  ];

  allPatterns.sort((a, b) => b.impact - a.impact);

  return allPatterns;
}
