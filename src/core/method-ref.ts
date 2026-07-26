import type { MethodBreakdown } from "../types/aggregated.js";

/**
 * The canonical `"FunctionName (ObjectType ObjectId)"` reference string.
 *
 * This lives in its own module rather than in `core/patterns.ts` because of the
 * layering problem that caused it to be duplicated in the first place:
 * `semantic/corroborate.ts` needs the format, but importing `core/patterns.ts`
 * would drag in `ProcessedNode`/`ProcessedProfile` — runtime-layer types the
 * semantic layer deliberately does not depend on. So the format was copied,
 * with a comment asking a future reader not to let the two drift. Two
 * definitions of one format is exactly the shape that drifts.
 *
 * Getting it wrong is not cosmetic. These strings become `involvedMethods`,
 * which is the finding-lifecycle fingerprint anchor: a byte that changes here
 * severs every stored finding's identity and resurfaces it as new. Any edit to
 * this function must keep the output byte-identical.
 *
 * The parameter is a `Pick` rather than a full `MethodBreakdown` so a caller
 * holding only the three identifying fields — which is all this needs — does
 * not have to fabricate timing data to call it.
 */
export function formatMethodBreakdownRef(
	method: Pick<MethodBreakdown, "functionName" | "objectType" | "objectId">,
): string {
	return `${method.functionName} (${method.objectType} ${method.objectId})`;
}
