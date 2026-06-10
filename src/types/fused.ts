/**
 * fused.ts — The fused data model for the al-perf × al-sem correlation layer.
 *
 * Architecture: a SIDE MAP (not a MethodBreakdown intersection).
 *   Map<methodKey, SemanticAttribution>
 * keyed by al-perf's canonical method key: `${functionName}_${objectType}_${objectId}`.
 *
 * al-perf's existing types and output are byte-IDENTICAL when fusion is off or
 * absent — this is strictly additive.
 *
 * Defined here for P1b; consumed by P1c (fuseProfile), P2 (UX), P3 (call-graph).
 */

import type {
	AppIdentity,
	CoverageEntry,
	DiagnosticContract,
	FindingSummary,
	RoutineIdentity,
} from "../semantic/contracts.js";

// ---------------------------------------------------------------------------
// Correlation statuses (the honesty contract)
// ---------------------------------------------------------------------------

/**
 * The correlation status of an al-perf method against the al-sem universe.
 *
 *  matched       — exactly one universe routine matched; findings attached
 *                  (possibly empty → see `matchedClean` flag).
 *  matched-clean — in the universe, zero findings (matched but no issues found).
 *                  Carried as status="matched" + findings=[] + matchedClean=true
 *                  on SemanticAttribution for compactness; this type documents
 *                  the semantic distinction.
 *  ambiguous     — multiple universe routines share (objectType,objectNumber,
 *                  routineName) (overloads); UNION of findings attached;
 *                  attributionConfidence="ambiguous". NEVER render as "caused by X".
 *  blind-spot    — the hot method has NO matching universe routine:
 *                  a builtin, an unanalysed dependency, a SQL frame, or simply
 *                  not in the analyzed workspace. Reason string is set.
 *  cold          — (workspace-level, not per-method) a universe routine for which
 *                  there is NO runtime sample in this profile. Surfaced in
 *                  FusedModel.coldFindings.
 *  unkeyable     — a finding whose primaryLocation has no routineName (or an
 *                  unparseable objectId); cannot be joined to any method.
 *                  Surfaced in FusedModel.unkeyableFindings — NOT cold.
 *
 * NOTE: only `matched`, `ambiguous`, and `blind-spot` are per-method statuses on
 * SemanticAttribution. The other "states" are modeled via flags/buckets, NOT as
 * status values:
 *  - matched-clean → status="matched" + `matchedClean: true` on the attribution.
 *  - cold          → FusedModel.coldRoutines / FusedModel.coldFindings.
 *  - unkeyable     → FusedModel.unkeyableFindings.
 *  - orphan        → FusedModel.orphanFindings (keyed finding, routine absent
 *                    from the inventory — distinct from cold).
 */
export type CorrelationStatus = "matched" | "ambiguous" | "blind-spot";

/** How confident the attribution is. */
export type AttributionConfidence = "exact" | "ambiguous";

// ---------------------------------------------------------------------------
// SemanticAttribution — per-method correlation result
// ---------------------------------------------------------------------------

/**
 * The semantic attribution for a single al-perf method.
 *
 * Keyed in FusedModel.attributions by the al-perf canonical method key
 * (`${functionName}_${objectType}_${objectId}`).
 */
export interface SemanticAttribution {
	/** Correlation outcome for this method. */
	status: CorrelationStatus;

	/**
	 * Findings attached to this method (sorted by (fingerprint, id) for
	 * determinism). Empty for matched-clean; the UNION for ambiguous.
	 */
	findings: FindingSummary[];

	/**
	 * How confident the attribution is.
	 *  "exact"     — exactly one universe routine matched.
	 *  "ambiguous" — multiple overloads; findings are the UNION.
	 */
	attributionConfidence: AttributionConfidence;

	/**
	 * `true` when the method is in the universe but has zero findings.
	 * (status="matched", findings=[], matchedClean=true)
	 */
	matchedClean?: boolean;

	/**
	 * The StableRoutineId(s) of the matched universe routine(s).
	 *  - Exactly one for "matched" / "exact".
	 *  - Multiple (one per overload) for "ambiguous".
	 *  - Absent for "blind-spot".
	 *
	 * Persisted here so P3 can join the call graph without re-correlating.
	 */
	stableRoutineId?: string | string[];

	/**
	 * Human-readable reason string, set for:
	 *  - "blind-spot": why the method has no universe match.
	 *  - "ambiguous": additional context (optional).
	 */
	reason?: string;

	/**
	 * Runtime-correlation corroboration (P3.1, spec Revision-2 R3-5/R3-6/R3-7).
	 *
	 * The ids of al-perf's OWN runtime-shape pattern detectors (`src/core/patterns.ts`)
	 * that fire on THIS routine AND describe the SAME phenomenon as one of this
	 * attribution's al-sem findings (per the curated `corroboration-map.ts`). Populated
	 * by `corroborate()` — sorted + deduped — ONLY for `status === "matched"`
	 * attributions; absent when no runtime pattern corroborates.
	 *
	 * This is CORRELATION, not causation (R3-6): co-occurrence on one routine earns the
	 * "runtime-correlated" badge, never "runtime-confirmed". ONLY runtime-provenance
	 * patterns appear here — al-perf's source-static/source-only scans never corroborate.
	 */
	corroboratingPatterns?: string[];
}

// ---------------------------------------------------------------------------
// Correlation summary counters
// ---------------------------------------------------------------------------

export interface CorrelationSummary {
	/** Methods matched to exactly one universe routine (including matched-clean). */
	matched: number;
	/** Subset of `matched` where findings=[] (in-universe, no issue found). */
	matchedClean: number;
	/** Methods matched to multiple overloads (UNION findings). */
	ambiguous: number;
	/** Methods not in the universe (builtins, deps, SQL frames, unanalysed). */
	blindSpot: number;
	/** Universe routines with no runtime sample. */
	coldCount: number;
	/** Findings with no join key (no routineName or unparseable objectId). */
	unkeyableCount: number;
	/**
	 * Findings whose join key has NO universe routine (routine absent from the
	 * inventory) — distinct from cold (which requires an in-universe routine).
	 */
	orphanCount: number;
}

// ---------------------------------------------------------------------------
// FusedModel — the top-level result
// ---------------------------------------------------------------------------

/** The workspace-mismatch warning (zero intersection over a non-trivial profile). */
export interface MismatchWarning {
	reason: string;
}

/** Engine metadata carried on the fused model. */
export interface EngineMetadata {
	alsemVersion: string;
	primaryApp: AppIdentity | undefined;
	diagnostics: DiagnosticContract[];
}

/**
 * The fused model: a side-map joining al-perf hotspot methods to al-sem
 * static findings.
 *
 * This is the structure P2–P4 consume. `attributions` is the primary data
 * surface; the other fields are workspace-level metadata.
 */
export interface FusedModel {
	/**
	 * Per-method correlation results, keyed by al-perf's canonical method key:
	 * `${functionName}_${objectType}_${objectId}`.
	 *
	 * Only AL routine frames (`isAlRoutineFrame`) are included; SQL/builtin
	 * frames are omitted.
	 */
	attributions: Map<string, SemanticAttribution>;

	/**
	 * Universe routines (from the engine inventory) for which there is NO runtime
	 * sample in this profile — "statically flagged but not hot". P2 wants the
	 * routine IDENTITIES (not just a count), e.g. to surface dead-but-flagged
	 * routines. Sorted by stableRoutineId for determinism.
	 */
	coldRoutines: RoutineIdentity[];

	/**
	 * Findings attached to a COLD universe routine (in the inventory, no runtime
	 * sample). A cold routine may also have zero findings; this list is just the
	 * findings that land on cold keys. Sorted by (fingerprint, id).
	 */
	coldFindings: FindingSummary[];

	/**
	 * Findings whose join key is keyable but has NO universe routine (the routine
	 * is absent from the inventory). Distinct from cold (which requires an
	 * in-universe routine) and from unkeyable (which has no join key at all).
	 * Sorted by (fingerprint, id).
	 */
	orphanFindings: FindingSummary[];

	/**
	 * Findings whose primaryLocation has no `routineName` or an unparseable
	 * `objectId` — they cannot be joined to any method key. Sorted by
	 * (fingerprint, id). NOT the same as cold or orphan.
	 */
	unkeyableFindings: FindingSummary[];

	/** Coverage entries from the engine inventory. */
	coverage: CoverageEntry[];

	/** Aggregated correlation counts. */
	correlationSummary: CorrelationSummary;

	/**
	 * Set when the identity intersection between the profiled methods and the
	 * analyzed workspace is zero over a non-trivial profile — likely a mismatch
	 * between the --source workspace and the profiled app.
	 */
	mismatch?: MismatchWarning;

	/** Engine metadata (version, primary app, diagnostics). */
	engine: EngineMetadata;
}
