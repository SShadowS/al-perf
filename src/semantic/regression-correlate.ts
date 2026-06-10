/**
 * regression-correlate.ts — Pure regression×static correlation substrate.
 *
 * `classifyDelta`         — basis (self|total|none) + strength (strong|moderate|weak)
 *                           for each diff-delta kind (PR2-2).
 * `correlateRegressions`  — join `ComparisonResult.regressions[]` ↔ `DiffDelta[]`
 *                           by canonical routine key, matrix by basis, produce
 *                           `RegressionFusion` (PR2-1/2/3/4/5/7/8).
 *
 * PURE — no I/O, no filesystem, no subprocess.
 * DETERMINISM — driven off ordered `regressions[]` / `findings[]`; no Map iteration
 * in output; plain arrays/objects only (PR2-8).
 */

import type { MethodDelta } from "../output/types.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import { makeMethodJoinKey, makeRoutineJoinKey } from "./correlate.js";
import type { DiffAnalysis, DiffDelta } from "./diff-runner.js";

// ---------------------------------------------------------------------------
// Internal join-key adapter
// ---------------------------------------------------------------------------

/**
 * Derive a method-side join key from a `MethodDelta`.
 * `MethodDelta` shares the three fields (`functionName`, `objectType`, `objectId`)
 * that `makeMethodJoinKey` actually reads from `MethodBreakdown`, so the cast is
 * safe — we only use the join-key fields.
 */
function methodDeltaJoinKey(m: MethodDelta): string {
	return makeMethodJoinKey(m as unknown as MethodBreakdown);
}

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

/** Classification result for a single diff-delta kind. */
export interface DeltaClassification {
	/**
	 * Which perf metric this delta kind is expected to affect:
	 * - "total"  — cost lands in child frames (DB/IO ops); correlate vs deltaTotalTime.
	 * - "self"   — cost is caller-side cycles / structural; correlate vs deltaSelfTime.
	 * - "none"   — cross-boundary (event-publish); not a local perf correlation.
	 */
	basis: "self" | "total" | "none";
	/** How reliably this kind explains a regression. */
	strength: "strong" | "moderate" | "weak";
}

/** A diff delta enriched with classification, used in the output. */
export interface DiffDeltaSummary {
	category: string;
	kind: string;
	severity: string;
	displayName: string;
	basis: DeltaClassification["basis"];
	strength: DeltaClassification["strength"];
	resourceKind?: string;
	resourceId?: string;
	op?: string;
	/**
	 * true when this delta summary is attached to a regression via a multi-
	 * stableId join key (overloads / field-triggers sharing a bare name).
	 * Signals UNION attribution — not precise to a single routine (PR2-3).
	 */
	ambiguous?: boolean;
	/**
	 * The before-WS stableId for renamed routines (DISPLAY-ONLY — shows rename
	 * provenance "renamed from X"; NOT used as a join key per PR2-3).
	 */
	oldOriginalStableId?: string;
}

/** An annotated regression: the MethodDelta + its correlated static deltas. */
export interface AnnotatedRegression {
	method: MethodDelta;
	/**
	 * Matching-basis static deltas from the diff (empty array when unexplained).
	 * Entries are in diff engine order (PR2-8).
	 */
	staticDeltas: DiffDeltaSummary[];
	/**
	 * Correlation status derived from the matching-basis deltas:
	 * - "correlated"          — ≥1 strong/moderate matching-basis delta.
	 * - "weakly-correlated"   — only weak matching-basis deltas.
	 * - "unexplained-static"  — no matching-basis delta for this regression.
	 */
	status: "correlated" | "weakly-correlated" | "unexplained-static";
}

/** A new or removed method matched to a procedure-added / -removed delta. */
export interface MethodMatch {
	method: MethodBreakdown;
	delta: DiffDeltaSummary;
}

/** Version mismatch diagnostic from the version guard (PR2-4). */
export interface VersionMismatch {
	beforeProfileVersion: string | undefined;
	beforeWorkspaceVersion: string | undefined;
	afterProfileVersion: string | undefined;
	afterWorkspaceVersion: string | undefined;
}

/** The full regression-fusion output. */
export interface RegressionFusion {
	annotatedRegressions: AnnotatedRegression[];
	/** New hot methods matched to procedure-added deltas (PR2-5 headline). */
	newMethodCorrelations: MethodMatch[];
	/** Removed methods matched to procedure-removed deltas (PR2-5 headline). */
	removedMethodCorrelations: MethodMatch[];
	/**
	 * Diff deltas that matched NO regression/new/removed (static-only changes).
	 * Includes event-publish deltas tagged cross-boundary (PR2-7).
	 */
	staticOnlyChanges: DiffDeltaSummary[];
	correlationSummary: {
		correlated: number;
		weaklyCorrelated: number;
		unexplained: number;
		/** Present when profile app versions don't match workspace versions (PR2-4). */
		versionMismatch?: VersionMismatch;
	};
}

// ---------------------------------------------------------------------------
// classifyDelta — PR2-2 perf-relevance matrix
// ---------------------------------------------------------------------------

/**
 * Pure function: derive the correlation basis + strength for a diff-delta kind.
 *
 * PR2-2 table (verified against real attribution model):
 *   capability-gained-commit/write/read  → total / strong   (DB cost in child frame)
 *   capability-gained-http/file          → total / moderate  (blocking IO in child frame)
 *   procedure-signature-changed          → self  / moderate  (new caller-side cycles)
 *   capability-gained-dynamic-dispatch   → self  / moderate  (indirection overhead)
 *   procedure-added                      → self  / strong    (new hot entry point)
 *   capability-gained-telemetry          → self  / weak      (cheap, rarely causal)
 *   capability-gained-isolated-storage   → self  / weak
 *   capability-gained-event-publish      → none  / weak      (cross-boundary PR2-7)
 *   events category                      → none  / weak      (cross-boundary PR2-7)
 *   default                              → self  / weak
 *
 * A drift-guard test pins this table.
 */
export function classifyDelta(
	category: string,
	kind: string,
): DeltaClassification {
	// Cross-boundary: event-publish and all events-category deltas (PR2-7).
	if (kind === "capability-gained-event-publish" || category === "events") {
		return { basis: "none", strength: "weak" };
	}

	switch (kind) {
		// Strong total-basis: DB operations (cost lands in child SQL frame).
		case "capability-gained-commit":
		case "capability-gained-write":
		case "capability-gained-read":
			return { basis: "total", strength: "strong" };

		// Moderate total-basis: blocking IO in child frame.
		case "capability-gained-http":
		case "capability-gained-file":
			return { basis: "total", strength: "moderate" };

		// Moderate self-basis: structural or dispatch overhead in caller.
		case "procedure-signature-changed":
		case "capability-gained-dynamic-dispatch":
			return { basis: "self", strength: "moderate" };

		// Strong self-basis: a newly introduced procedure appearing as hot.
		case "procedure-added":
			return { basis: "self", strength: "strong" };

		// Weak self-basis: cheap capabilities that rarely explain CPU regressions.
		case "capability-gained-telemetry":
		case "capability-gained-isolated-storage":
			return { basis: "self", strength: "weak" };

		// Default: self / weak (unknown or capability-lost, permission deltas, etc.)
		default:
			return { basis: "self", strength: "weak" };
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Project a DiffDelta to a DiffDeltaSummary with classification. */
function toDeltaSummary(
	delta: DiffDelta,
	ambiguous?: boolean,
): DiffDeltaSummary {
	const { basis, strength } = classifyDelta(delta.category, delta.kind);
	const s: DiffDeltaSummary = {
		category: delta.category,
		kind: delta.kind,
		severity: delta.severity,
		displayName: delta.displayName,
		basis,
		strength,
	};
	if (delta.resourceKind !== undefined) s.resourceKind = delta.resourceKind;
	if (delta.resourceId !== undefined) s.resourceId = delta.resourceId;
	if (delta.op !== undefined) s.op = delta.op;
	if (ambiguous === true) s.ambiguous = true;
	// Carry rename provenance (DISPLAY-ONLY — PR2-3 warns against using as join key).
	if (delta.oldOriginalStableId !== undefined)
		s.oldOriginalStableId = delta.oldOriginalStableId;
	return s;
}

/**
 * Derive the correlation status from a list of already-classified matching-basis
 * DiffDeltaSummary entries.
 */
function deriveStatus(
	matchingBasis: DiffDeltaSummary[],
): AnnotatedRegression["status"] {
	if (matchingBasis.length === 0) return "unexplained-static";
	const hasStrongOrModerate = matchingBasis.some(
		(d) => d.strength === "strong" || d.strength === "moderate",
	);
	return hasStrongOrModerate ? "correlated" : "weakly-correlated";
}

// ---------------------------------------------------------------------------
// correlateRegressions — the main join
// ---------------------------------------------------------------------------

/**
 * Profile app versions supplied by the caller for the version guard (PR2-4).
 * These come from the profile's `declaringApplication.appVersion` field.
 * Either may be undefined when the profile doesn't carry the version.
 */
export interface ProfileVersions {
	before?: string;
	after?: string;
}

/**
 * Correlate runtime regressions with static diff deltas.
 *
 * @param comparison  — `ComparisonResult` (regressions/newMethods/removedMethods).
 * @param diff        — Parsed diff-report (`DiffAnalysis` from runEngineDiff).
 * @param profileVersions — App versions from the before/after profiles (PR2-4).
 *
 * Returns a `RegressionFusion` — plain arrays/objects, no Map in output.
 */
export function correlateRegressions(
	comparison: {
		regressions: MethodDelta[];
		newMethods: MethodBreakdown[];
		removedMethods: MethodBreakdown[];
	},
	diff: DiffAnalysis,
	profileVersions: ProfileVersions = {},
): RegressionFusion {
	const { regressions, newMethods, removedMethods } = comparison;
	const { findings, afterInventory, beforeAppVersion, afterAppVersion } = diff;

	// -------------------------------------------------------------------------
	// Build the join map: canonical join key → Set of after-inventory stableIds.
	// This enables UNION-on-collision for overloads/field-triggers (PR2-3).
	// -------------------------------------------------------------------------
	// join key → array of stableRoutineId (order-stable; we use the array as a set).
	const joinKeyToStableIds = new Map<string, string[]>();
	for (const r of afterInventory) {
		const key = makeRoutineJoinKey(r);
		const arr = joinKeyToStableIds.get(key);
		if (arr) {
			arr.push(r.stableRoutineId);
		} else {
			joinKeyToStableIds.set(key, [r.stableRoutineId]);
		}
	}

	// -------------------------------------------------------------------------
	// Build a lookup: stableId → all DiffDelta[] for that stableId.
	// IMPORTANT: we filter the ENGINE-ORDERED findings[] (PR2-8) — no Map iteration
	// in the output path.
	// -------------------------------------------------------------------------
	// We build this as stableId → index list (positions in findings[]) so we can
	// reconstruct sorted by engine order.
	const stableIdToFindingIndices = new Map<string, number[]>();
	for (let i = 0; i < findings.length; i++) {
		const f = findings[i];
		// Join key for the diff: `newStableId ?? normalizedStableId` (PR2-3).
		const joinId = f.newStableId ?? f.normalizedStableId;
		const arr = stableIdToFindingIndices.get(joinId);
		if (arr) {
			arr.push(i);
		} else {
			stableIdToFindingIndices.set(joinId, [i]);
		}
	}

	// Track which finding indices have been "consumed" by a regression or new/removed.
	const consumedFindingIndices = new Set<number>();

	// -------------------------------------------------------------------------
	// Helper: resolve a MethodDelta/MethodBreakdown join key → matched findings.
	// Returns { indices: number[]; ambiguous: boolean }
	// -------------------------------------------------------------------------
	function resolveFindingIndices(joinKey: string): {
		indices: number[];
		ambiguous: boolean;
	} {
		const stableIds = joinKeyToStableIds.get(joinKey);
		if (!stableIds || stableIds.length === 0)
			return { indices: [], ambiguous: false };

		const ambiguous = stableIds.length > 1;
		// Collect all indices from all matching stableIds; maintain engine order.
		const allIndices: number[] = [];
		for (const sid of stableIds) {
			const idxs = stableIdToFindingIndices.get(sid);
			if (idxs) allIndices.push(...idxs);
		}
		// Sort by engine order (index), deduplicate.
		allIndices.sort((a, b) => a - b);
		const deduped: number[] = [];
		for (const idx of allIndices) {
			if (deduped.length === 0 || deduped[deduped.length - 1] !== idx) {
				deduped.push(idx);
			}
		}
		return { indices: deduped, ambiguous };
	}

	// -------------------------------------------------------------------------
	// Process regressions (driven off ordered regressions[] — PR2-8).
	// -------------------------------------------------------------------------
	const annotatedRegressions: AnnotatedRegression[] = [];

	for (const method of regressions) {
		const joinKey = methodDeltaJoinKey(method);
		const { indices, ambiguous } = resolveFindingIndices(joinKey);

		// Matching-basis deltas: filter by whether the regression exists on the
		// delta's basis (PR2-1 matrix).
		const matchingBasis: DiffDeltaSummary[] = [];
		// Cross-boundary (event-publish / events category) → staticOnlyChanges.
		// We do NOT consume these as matching-basis, but DO mark them consumed.

		for (const idx of indices) {
			const delta = findings[idx];

			// procedure-added / procedure-removed are structural-existence deltas
			// handled by the new/removed-method correlation (PR2-5). Skip them here
			// so a delta can never be double-attributed (annotated on a regression
			// AND matched in the new/removed loop). Implausible in practice (a
			// removed proc being a live regression) but cheap to rule out.
			if (
				delta.kind === "procedure-added" ||
				delta.kind === "procedure-removed"
			) {
				continue;
			}

			const { basis } = classifyDelta(delta.category, delta.kind);

			// Cross-boundary deltas are NOT local annotations (PR2-7).
			if (basis === "none") {
				// Will go to staticOnlyChanges — do NOT consume from the "unmatched" pool
				// yet; we handle them globally below.
				continue;
			}

			// Basis gate (PR2-1 matrix):
			// - "total" delta needs deltaTotalTime > 0
			// - "self"  delta needs deltaSelfTime > 0
			const passes =
				basis === "total"
					? method.deltaTotalTime > 0
					: method.deltaSelfTime > 0;

			if (passes) {
				matchingBasis.push(toDeltaSummary(delta, ambiguous ? true : undefined));
				consumedFindingIndices.add(idx);
			}
		}

		annotatedRegressions.push({
			method,
			staticDeltas: matchingBasis,
			status: deriveStatus(matchingBasis),
		});
	}

	// -------------------------------------------------------------------------
	// New method correlations (PR2-5 headline): procedure-added matches.
	// -------------------------------------------------------------------------
	const newMethodCorrelations: MethodMatch[] = [];

	for (const method of newMethods) {
		const joinKey = makeMethodJoinKey(method);
		const { indices, ambiguous } = resolveFindingIndices(joinKey);

		for (const idx of indices) {
			const delta = findings[idx];
			if (delta.kind === "procedure-added") {
				newMethodCorrelations.push({
					method,
					delta: toDeltaSummary(delta, ambiguous ? true : undefined),
				});
				consumedFindingIndices.add(idx);
				break; // one match per method is sufficient
			}
		}
	}

	// -------------------------------------------------------------------------
	// Removed method correlations (PR2-5 headline): procedure-removed matches.
	// -------------------------------------------------------------------------
	const removedMethodCorrelations: MethodMatch[] = [];

	for (const method of removedMethods) {
		const joinKey = makeMethodJoinKey(method);
		const { indices, ambiguous } = resolveFindingIndices(joinKey);

		for (const idx of indices) {
			const delta = findings[idx];
			if (delta.kind === "procedure-removed") {
				removedMethodCorrelations.push({
					method,
					delta: toDeltaSummary(delta, ambiguous ? true : undefined),
				});
				consumedFindingIndices.add(idx);
				break;
			}
		}
	}

	// -------------------------------------------------------------------------
	// staticOnlyChanges: findings not consumed + event/events-category deltas.
	// Preserve ENGINE ORDER (iterate findings[] in order, PR2-8).
	// -------------------------------------------------------------------------
	const staticOnlyChanges: DiffDeltaSummary[] = [];
	for (let i = 0; i < findings.length; i++) {
		const delta = findings[i];
		const { basis } = classifyDelta(delta.category, delta.kind);

		if (basis === "none") {
			// Event-publish / events category → cross-boundary static-only (PR2-7).
			staticOnlyChanges.push(toDeltaSummary(delta));
		} else if (!consumedFindingIndices.has(i)) {
			staticOnlyChanges.push(toDeltaSummary(delta));
		}
	}

	// -------------------------------------------------------------------------
	// Correlation summary counts.
	// -------------------------------------------------------------------------
	let correlated = 0;
	let weaklyCorrelated = 0;
	let unexplained = 0;
	for (const ar of annotatedRegressions) {
		if (ar.status === "correlated") correlated++;
		else if (ar.status === "weakly-correlated") weaklyCorrelated++;
		else unexplained++;
	}

	// -------------------------------------------------------------------------
	// Version guard (PR2-4): compare profile app versions vs workspace app.json.
	// -------------------------------------------------------------------------
	const correlationSummary: RegressionFusion["correlationSummary"] = {
		correlated,
		weaklyCorrelated,
		unexplained,
	};

	const beforeMismatch =
		profileVersions.before !== undefined &&
		beforeAppVersion !== undefined &&
		profileVersions.before !== beforeAppVersion;
	const afterMismatch =
		profileVersions.after !== undefined &&
		afterAppVersion !== undefined &&
		profileVersions.after !== afterAppVersion;

	if (beforeMismatch || afterMismatch) {
		correlationSummary.versionMismatch = {
			beforeProfileVersion: profileVersions.before,
			beforeWorkspaceVersion: beforeAppVersion,
			afterProfileVersion: profileVersions.after,
			afterWorkspaceVersion: afterAppVersion,
		};
	}

	return {
		annotatedRegressions,
		newMethodCorrelations,
		removedMethodCorrelations,
		staticOnlyChanges,
		correlationSummary,
	};
}
