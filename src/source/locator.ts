import type {
  SourceIndex,
  ProcedureInfo,
  TriggerInfo,
} from "../types/source-index.js";
import type { MethodBreakdown } from "../types/aggregated.js";

export type SourceMatch = ProcedureInfo | TriggerInfo;

/**
 * Match a profile method to its source location in the index.
 *
 * Matching strategy:
 * 1. Exact match: name (case-insensitive) + objectId
 * 2. Name-only match: if there's exactly one candidate
 * 3. Disambiguate by objectType + objectId
 * 4. Fall back to triggers
 */
export function matchToSource(
  functionName: string,
  objectType: string,
  objectId: number,
  index: SourceIndex,
): SourceMatch | null {
  const nameLower = functionName.toLowerCase();

  const procCandidates = index.procedures.get(nameLower) ?? [];
  const trigCandidates = index.triggers.get(nameLower) ?? [];
  const allCandidates: SourceMatch[] = [...procCandidates, ...trigCandidates];

  if (allCandidates.length === 0) return null;

  // 1. Exact match: name + objectId
  const exactMatch = allCandidates.find((c) => c.objectId === objectId);
  if (exactMatch) return exactMatch;

  // 2. If only one candidate, use it
  if (allCandidates.length === 1) return allCandidates[0];

  // 3. Disambiguate by objectType + objectId
  const typeMatch = allCandidates.find(
    (c) => c.objectType === objectType && c.objectId === objectId,
  );
  if (typeMatch) return typeMatch;

  return null;
}

/**
 * Match all hotspot methods to source locations.
 */
export function matchAllHotspots(
  hotspots: MethodBreakdown[],
  index: SourceIndex,
): Map<string, SourceMatch> {
  const matches = new Map<string, SourceMatch>();
  for (const method of hotspots) {
    const key = `${method.functionName}_${method.objectType}_${method.objectId}`;
    const match = matchToSource(method.functionName, method.objectType, method.objectId, index);
    if (match) {
      matches.set(key, match);
    }
  }
  return matches;
}
