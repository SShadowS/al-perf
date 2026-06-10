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
	DiagnosticContract,
	FindingSummary,
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
	 * Reserved for P2: al-perf's own `patterns.ts` `runDetectors` flags on the
	 * same routine as al-sem (the highest-value "static cause + runtime confirmation"
	 * signal). Unfilled in P1 so P2 is not blocked.
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
	 * Universe routines (from the engine inventory) for which there is NO
	 * runtime sample in this profile — "statically flagged but not hot".
	 * These may still have findings; P2 uses them for background recommendations.
	 */
	coldFindings: FindingSummary[];

	/**
	 * Findings whose primaryLocation has no `routineName` or an unparseable
	 * `objectId` — they cannot be joined to any method key.
	 * NOT the same as cold (a cold routine may have no finding at all).
	 */
	unkeyableFindings: FindingSummary[];

	/** Coverage entries from the engine inventory. */
	coverage: import("../semantic/contracts.js").CoverageEntry[];

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
