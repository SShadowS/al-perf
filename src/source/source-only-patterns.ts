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
 * Run all source-only pattern detectors and return results sorted by impact descending.
 */
export function runSourceOnlyDetectors(index: SourceIndex): DetectedPattern[] {
  const allPatterns: DetectedPattern[] = [
    ...detectNestedLoops(index),
  ];

  allPatterns.sort((a, b) => b.impact - a.impact);

  return allPatterns;
}
