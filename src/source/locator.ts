import type { MethodBreakdown } from "../types/aggregated.js";
import type {
	ProcedureInfo,
	SourceIndex,
	TriggerInfo,
} from "../types/source-index.js";

export type SourceMatch = ProcedureInfo | TriggerInfo;

/**
 * Return ALL source-index candidates for `(functionName, objectType, objectId)`.
 *
 * The returned array may have:
 *  - 0 entries — no match found.
 *  - 1 entry  — unambiguous match; same as the old `matchToSource` result.
 *  - ≥2 entries — overloaded name: multiple routines share `(functionName, objectId)`
 *    (al-perf has no signature to disambiguate further). Callers that need to detect
 *    overloads should inspect `candidates.length > 1`.
 *
 * Matching strategy (applied in order, stopping at the first set that is non-empty):
 * 1. Exact match:   candidates with `objectId === objectId` (all of them).
 * 2. Name-only:     if there is exactly one candidate total, return it.
 * 3. Type+id match: candidates with `objectType === objectType && objectId === objectId`.
 *
 * The function name lookup is case-insensitive.
 */
export function matchAllToSource(
	functionName: string,
	objectType: string,
	objectId: number,
	index: SourceIndex,
): SourceMatch[] {
	const nameLower = functionName.toLowerCase();

	const procCandidates = index.procedures.get(nameLower) ?? [];
	const trigCandidates = index.triggers.get(nameLower) ?? [];
	const allCandidates: SourceMatch[] = [...procCandidates, ...trigCandidates];

	if (allCandidates.length === 0) return [];

	// 1. All candidates matching objectId (may be multiple overloads).
	const exactMatches = allCandidates.filter((c) => c.objectId === objectId);
	if (exactMatches.length > 0) return exactMatches;

	// 2. Single candidate regardless of objectId — return it.
	if (allCandidates.length === 1) return allCandidates;

	// 3. Narrow by objectType + objectId.
	const typeMatches = allCandidates.filter(
		(c) => c.objectType === objectType && c.objectId === objectId,
	);
	if (typeMatches.length > 0) return typeMatches;

	return [];
}

/**
 * Match a profile method to its source location in the index.
 *
 * Matching strategy:
 * 1. Exact match: name (case-insensitive) + objectId
 * 2. Name-only match: if there's exactly one candidate
 * 3. Disambiguate by objectType + objectId
 * 4. Fall back to triggers
 *
 * Returns the first result from `matchAllToSource`, or `null` when there is no
 * match. Existing callers are byte-unchanged.
 */
export function matchToSource(
	functionName: string,
	objectType: string,
	objectId: number,
	index: SourceIndex,
): SourceMatch | null {
	return matchAllToSource(functionName, objectType, objectId, index)[0] ?? null;
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
		const match = matchToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);
		if (match) {
			matches.set(key, match);
		}
	}
	return matches;
}
