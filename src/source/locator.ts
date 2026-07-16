import { canonicalObjectType } from "../semantic/identity.js";
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
 * 1. Type+id match: candidates with `canonicalObjectType(c.objectType) === canonicalObjectType(objectType)
 *    && c.objectId === objectId` (all of them). Object ids are unique only PER TYPE in AL, so this must
 *    come first — an id-only match would return a routine from the wrong object whenever two types
 *    share an id and a member name.
 * 2. Id-only:       candidates with `objectId === objectId` (all of them), regardless of type. Reached
 *    only when no candidate's type matched — preserves recall for an absent/unrecognized caller type.
 * 3. Name-only:     if there is exactly one candidate total, return it.
 *
 * The function name lookup is case-insensitive; so is the object-type comparison (via `canonicalObjectType`).
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

	// 1. Canonical (objectType, objectId) match — the precise answer. objectIds
	//    are unique only PER TYPE in AL (Table 50999 and Codeunit 50999 coexist),
	//    so an id-only match returns a routine from the wrong object whenever two
	//    types share an id and a member name. canonicalObjectType absorbs the
	//    profile-says-"CodeUnit" / index-says-"Codeunit" casing split.
	const wantType = canonicalObjectType(objectType);
	const typeAndId = allCandidates.filter(
		(c) =>
			c.objectId === objectId && canonicalObjectType(c.objectType) === wantType,
	);
	if (typeAndId.length > 0) return typeAndId;

	// 2. Fallback: id-only. Reached only when NO candidate's type matched — an
	//    absent or unrecognized caller type must not silently drop a real match.
	//    Preserves the recall of the previous id-only step 1.
	const idOnly = allCandidates.filter((c) => c.objectId === objectId);
	if (idOnly.length > 0) return idOnly;

	// 3. Single candidate regardless of objectId — return it.
	if (allCandidates.length === 1) return allCandidates;

	return [];
}

/**
 * Match a profile method to its source location in the index.
 *
 * See `matchAllToSource` for the matching strategy (type+id, then id-only
 * fallback, then name-only). Procedures and triggers are both searched.
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
