/**
 * views.ts — Pure, JSON-safe view layer over FusedModel (P2.0).
 *
 * Two derived views:
 *  - `annotateHotspots`   — one annotation per AL method, ordered like methods[].
 *  - `prioritizeFindings` — findings ranked by runtime cost; split into
 *                           weighted (hot) and unweighted (cold/blind/unkeyable).
 *
 * Satisfies: R2-1 (no Map/Set in output), R2-3 (selfTime primary rank),
 *            R2-8 (ambiguous CPU sum), R2-9/R2-10 (honesty fields verbatim),
 *            R2-12 (cold→unweighted split), R2-14 (determinism off ordered methods[]).
 */

import type { MethodBreakdown } from "../types/aggregated.js";
import type {
	AttributionConfidence,
	CorrelationStatus,
	CorrelationSummary,
	FusedModel,
} from "../types/fused.js";
import type { FindingSummary, RoutineIdentity } from "./contracts.js";
import {
	makeMethodJoinKey,
	makeRoutineJoinKey,
	methodAttrKey,
} from "./correlate.js";
import { corroboratesDetector } from "./corroboration-map.js";

// ---------------------------------------------------------------------------
// Output types (defined once here; reused by AnalysisResult + renderers)
// ---------------------------------------------------------------------------

/**
 * One runtime hotspot joined to its static attribution.
 * Rendered in-place in the hotspots table (R2-4).
 *
 * Join key = `${functionName}_${objectType}_${objectId}` — identical to
 * correlate's methodAttrKey, so views and correlate are always in sync.
 */
export interface HotspotAnnotation {
	/** Join key = `${functionName}_${objectType}_${objectId}`. */
	attrKey: string;
	status: CorrelationStatus;
	attributionConfidence: AttributionConfidence;
	findings: FindingSummary[];
	/** true ONLY when the routine is verified clean under full coverage (R2-10). */
	matchedClean?: boolean;
	/** "coverage incomplete" / blind-spot reason (R2-9, R2-10). */
	reason?: string;
	stableRoutineId?: string | string[];
	/** Reserved: P3 cross-signal corroboration (leaf-only per R2-13). */
	corroboratingPatterns?: string[];
}

/**
 * One step in the resolved causal chain attached to a weighted PrioritizedFinding
 * (P3.2b). Derived from the engine's `evidencePath`, enriched with runtime cost
 * for the step's routine when it appears in the profile (hot) or cost-resolved.
 *
 * HONESTY: percentages are only present when the step's routineId resolved to a
 * MethodBreakdown in the profile. For cross-app, builtin, or inlined steps the
 * percentages are `undefined` and `isHot` is `false` — no fabricated cost.
 */
export interface CausalStep {
	/** Diagnostic note from the engine's evidence step (e.g. "for loop", "calls"). */
	note: string;
	/** Resolved routine name (from inventory); undefined when routineId not in inventory. */
	routineName?: string;
	/** Resolved object type (from inventory); undefined when routineId not in inventory. */
	objectType?: string;
	/** Resolved object id (from inventory); undefined when routineId not in inventory. */
	objectId?: number;
	/** Source unit id (file) from the evidence step anchor. */
	file: string;
	/** Source line from the evidence step anchor. */
	line: number;
	/**
	 * Self-time % from the matched MethodBreakdown (runtime cost of this step's
	 * routine in this profile). Undefined when the routine has no runtime sample
	 * in this profile (not hot, cross-app, inlined, or builtin).
	 */
	selfTimePercent?: number;
	/**
	 * Total-time % from the matched MethodBreakdown. Undefined when unresolved
	 * (same condition as selfTimePercent).
	 */
	totalTimePercent?: number;
	/**
	 * `true` when the step's routine appears in the profile with self-time > 0
	 * (i.e. this step is itself a hot frame). `false` for all unresolved steps
	 * and for zero-self orchestrators.
	 */
	isHot: boolean;
	/**
	 * Number of intermediate steps elided IMMEDIATELY AFTER this step when a
	 * consumer truncates the chain (P3.2b MCP context guard). Absent (undefined)
	 * on the full, untruncated chain that views.ts emits — it is stamped only by
	 * a downstream capper (see mcp/server.ts `capCausalChain`). When present and
	 * > 0 it signals that the chain is NON-CONTIGUOUS at this point: `n` steps
	 * were dropped between this step and the next one in the array, so an LLM must
	 * not read consecutive retained steps as direct caller→callee links.
	 */
	omittedAfter?: number;
}

/**
 * A static finding weighted by the runtime cost of the routine(s) it sits on.
 * Findings spanning N ambiguous frames have CPU summed across all frames (R2-8).
 *
 * In the `weighted` list, `selfTimePercent` (the SUM across ambiguous frames) is
 * always > 0 (R2-12). A matched finding whose every hot frame has selfTime 0
 * (e.g. an orchestrator whose cost is all in callees) is NOT in `weighted`; it
 * appears only in `hotspotAnnotations` (in place on its hotspot) and is counted
 * in `correlationSummary.matched`. Rows in the `unweightedFindings` bucket have
 * `selfTimePercent === 0` and carry a `bucket` of cold/orphan/unkeyable.
 */
export interface PrioritizedFinding {
	finding: FindingSummary;
	/** Representative method (highest self-time frame; tiebroken by functionName). */
	functionName: string;
	objectType: string;
	objectId: number;
	appName: string;
	/** SUM across all ambiguous frames sharing this finding (R2-8). */
	selfTimePercent: number;
	totalTimePercent: number;
	gapTime?: number;
	/** Representative frame's selfTime/totalTime — flags orchestrators (R2-3). */
	efficiencyScore: number;
	/**
	 * Number of distinct hot method frames this finding spans (>1 ⇒ ambiguous);
	 * 0 for unweighted findings (no hot frame).
	 */
	frameCount: number;
	status: CorrelationStatus;
	attributionConfidence: AttributionConfidence;
	/**
	 * For unweighted findings only: which honest bucket this row came from
	 * (cold/orphan/unkeyable). Absent on weighted rows (they have a real
	 * per-method `status`). Carried so renderers don't flatten the distinction.
	 */
	bucket?: "cold" | "orphan" | "unkeyable";
	/**
	 * Runtime-corroboration patterns (P3.1, R3-6): subset of the attribution's
	 * `corroboratingPatterns` whose map entry actually corroborates THIS finding's
	 * `detector`. Per-finding precision: a sibling finding on the same routine whose
	 * detector is NOT in the map gets nothing. Weighted-only (R2-12): never set on
	 * unweighted/cold rows. Omitted when empty.
	 */
	corroboratingPatterns?: string[];
	/**
	 * Resolved causal chain (P3.2b, R2-12): present ONLY on weighted findings that
	 * carry an `evidencePath` from the engine. Each step is the engine's evidence
	 * step enriched with the matched routine's runtime cost (selfTimePercent /
	 * totalTimePercent) when available. HONESTY: steps whose routineId has no
	 * runtime sample carry no percentages + isHot:false — never fabricated.
	 * Absent on unweighted/cold/orphan/unkeyable rows.
	 */
	causalSteps?: CausalStep[];
}

/**
 * JSON-safe carrier attached to AnalysisResult — NO Map/Set (R2-1).
 * Absent when fusion is off → existing output is byte-unchanged.
 */
export interface FusionViews {
	/** One annotation per AL hotspot, in methods[] order (R2-14). */
	hotspotAnnotations: HotspotAnnotation[];
	/**
	 * Weighted = summed selfTimePercent > 0, ranked by selfTime desc (R2-3/R2-12).
	 * Zero-self matched findings (orchestrators whose cost is all in callees) are
	 * NOT here — they appear only in `hotspotAnnotations` + `correlationSummary`.
	 */
	prioritizedFindings: PrioritizedFinding[];
	/** Cold/orphan/unkeyable findings, weight 0, separate bucket (R2-12). */
	unweightedFindings: PrioritizedFinding[];
	correlationSummary: CorrelationSummary;
}

// ---------------------------------------------------------------------------
// annotateHotspots
// ---------------------------------------------------------------------------

/**
 * One annotation per AL hotspot in the SAME order as `methods` (R2-14).
 *
 * Carries the P1 honesty signals verbatim — `matchedClean` is true ONLY
 * when the P1 gate set it true; `reason` surfaces "coverage incomplete" /
 * blind-spot text (R2-9/R2-10). Methods with no attribution (non-AL frames
 * that the join skipped) are omitted.
 */
export function annotateHotspots(
	fused: FusedModel,
	methods: MethodBreakdown[],
): HotspotAnnotation[] {
	const out: HotspotAnnotation[] = [];
	for (const m of methods) {
		const key = methodAttrKey(m);
		const attr = fused.attributions.get(key);
		if (!attr) continue; // non-AL / unjoined frame → no annotation
		out.push({
			attrKey: key,
			status: attr.status,
			attributionConfidence: attr.attributionConfidence,
			findings: attr.findings,
			matchedClean: attr.matchedClean,
			reason: attr.reason,
			stableRoutineId: attr.stableRoutineId,
			corroboratingPatterns: attr.corroboratingPatterns,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// prioritizeFindings
// ---------------------------------------------------------------------------

/**
 * Static findings weighted by runtime cost. Ranked by selfTimePercent desc
 * (R2-3: totalTime is inclusive/orchestrator-skewed). A finding spanning N
 * ambiguous hot frames is ONE row whose CPU is the SUM across frames (R2-8).
 *
 * `weighted` is summed-selfTimePercent>0 ONLY (R2-12): a matched finding whose
 * every hot frame has selfTime 0 is excluded (it stays honestly visible via
 * `annotateHotspots` + `correlationSummary.matched`). Findings on
 * cold/orphan/unkeyable routines have no runtime sample → `unweighted`, never
 * weighted/dropped (R2-12). Drives off the ordered `methods[]` for determinism
 * (R2-14).
 */
/**
 * Build a Map from :-form stableRoutineId → MethodBreakdown by cross-indexing
 * the inventory routines against the profile method breakdowns.
 *
 * The join key is derived by the SAME canonical helpers correlate uses —
 * `makeMethodJoinKey` (canonicalObjectType, objectNumber,
 * normalizeTriggerName(functionName)) for methods and `makeRoutineJoinKey`
 * (canonicalObjectType, objectNumber, routineName) for routines — so the
 * drilldown join can NEVER drift from the correlation join. This matters most
 * for field/control triggers: the profile method functionName is
 * "<member> - OnValidate" while the inventory routineName is the bare
 * "OnValidate"; only by normalizing the METHOD side (normalizeTriggerName,
 * applied inside makeMethodJoinKey) do the two sides meet. Object-type aliases
 * (e.g. "CodeUnit" vs "Codeunit") are unified by canonicalObjectType.
 *
 * When a stableRoutineId is not in the routines array, or its corresponding
 * profile method is absent (the routine wasn't hot), the result is undefined
 * for that key (HONEST — no fabricated cost).
 *
 * NOTE: this is a best-effort lookup. An ambiguous match (two inventory routines
 * sharing the same join key) will map to the first hit — the same behaviour as
 * the original correlate ambiguous path.
 */
function buildStableIdToMethodMap(
	routines: RoutineIdentity[],
	methods: MethodBreakdown[],
): Map<string, MethodBreakdown> {
	// Index methods by the canonical method join key (normalizeTriggerName +
	// canonicalObjectType applied inside makeMethodJoinKey). First write wins for
	// duplicate keys — matches correlate's ambiguous-first-hit behaviour.
	const methodIndex = new Map<string, MethodBreakdown>();
	for (const m of methods) {
		const key = makeMethodJoinKey(m);
		if (!methodIndex.has(key)) {
			methodIndex.set(key, m);
		}
	}

	const result = new Map<string, MethodBreakdown>();
	for (const r of routines) {
		const m = methodIndex.get(makeRoutineJoinKey(r));
		if (m) {
			result.set(r.stableRoutineId, m);
		}
	}
	return result;
}

export function prioritizeFindings(
	fused: FusedModel,
	methods: MethodBreakdown[],
	routines?: RoutineIdentity[],
): { weighted: PrioritizedFinding[]; unweighted: PrioritizedFinding[] } {
	// Build the stableRoutineId → MethodBreakdown map for causal-chain enrichment.
	// Prefer the explicit routines parameter; fall back to fused.allRoutines (set by
	// fuseProfile); if neither is available the map is empty → all evidence steps
	// resolve to "no sample" (honest: no fabricated cost).
	const effectiveRoutines = routines ?? fused.allRoutines;
	const stableIdToMethod: Map<string, MethodBreakdown> =
		effectiveRoutines && effectiveRoutines.length > 0
			? buildStableIdToMethodMap(effectiveRoutines, methods)
			: new Map();

	// Accumulate per-finding across all hot frames that carry it.
	interface Acc {
		finding: FindingSummary;
		selfTimePercent: number;
		totalTimePercent: number;
		gapTime: number;
		frameCount: number;
		status: CorrelationStatus;
		attributionConfidence: AttributionConfidence;
		// representative frame (highest selfTime; tiebreak by functionName asc)
		rep: MethodBreakdown;
		// TRUE UNION of corroborating patterns across ALL frames carrying this
		// fingerprint. A finding spanning N ambiguous frames may sit on N distinct
		// attributions (different methodAttrKeys) with DIVERGENT corroborating sets;
		// we accumulate every frame's patterns so none are dropped.
		attrCorroboratingPatterns: Set<string>;
	}

	const acc = new Map<string, Acc>(); // keyed by finding.fingerprint

	for (const m of methods) {
		const attr = fused.attributions.get(methodAttrKey(m));
		if (!attr || attr.findings.length === 0) continue;
		for (const finding of attr.findings) {
			const existing = acc.get(finding.fingerprint);
			if (!existing) {
				acc.set(finding.fingerprint, {
					finding,
					selfTimePercent: m.selfTimePercent,
					totalTimePercent: m.totalTimePercent,
					gapTime: m.gapTime ?? 0,
					frameCount: 1,
					status: attr.status,
					attributionConfidence: attr.attributionConfidence,
					rep: m,
					attrCorroboratingPatterns: new Set(attr.corroboratingPatterns ?? []),
				});
			} else {
				existing.selfTimePercent += m.selfTimePercent; // SUM (R2-8)
				existing.totalTimePercent += m.totalTimePercent;
				existing.gapTime += m.gapTime ?? 0;
				existing.frameCount += 1;
				// representative = highest self-time frame; tiebreak by functionName asc
				if (
					m.selfTimePercent > existing.rep.selfTimePercent ||
					(m.selfTimePercent === existing.rep.selfTimePercent &&
						m.functionName < existing.rep.functionName)
				) {
					existing.rep = m;
				}
				// TRUE UNION across frames: merge THIS frame's corroborating patterns
				// into the accumulated set, so divergent sets on different attributions
				// for the same fingerprint are all retained (not just the first).
				if (attr.corroboratingPatterns) {
					for (const pid of attr.corroboratingPatterns) {
						existing.attrCorroboratingPatterns.add(pid);
					}
				}
			}
		}
	}

	const toPrioritized = (a: Acc): PrioritizedFinding => {
		// Per-finding precision (R3-6): filter the unioned attribution-level patterns
		// to only those that actually corroborate THIS finding's detector, then sort
		// for determinism (the Set's insertion order is not stable across frame orders).
		const perFindingPatterns = [...a.attrCorroboratingPatterns]
			.filter((pid) => corroboratesDetector(pid, a.finding.detector))
			.sort((x, y) => x.localeCompare(y));

		// P3.2b: build causalSteps from the engine evidencePath (weighted-only, R2-12).
		// Preserve evidencePath order (deterministic — the engine emits a fixed order).
		// HONEST: steps whose routineId has no runtime sample carry no percentages.
		let causalSteps: CausalStep[] | undefined;
		if (a.finding.evidencePath && a.finding.evidencePath.length > 0) {
			const steps: CausalStep[] = a.finding.evidencePath.map((step) => {
				const m = stableIdToMethod.get(step.routineId);
				if (m) {
					return {
						note: step.note,
						routineName: m.functionName,
						objectType: m.objectType,
						objectId: m.objectId,
						file: step.file,
						line: step.line,
						selfTimePercent: m.selfTimePercent,
						totalTimePercent: m.totalTimePercent,
						isHot: m.selfTimePercent > 0,
					};
				}
				// Unresolved step: cross-app, builtin, inlined — no fabricated cost.
				return {
					note: step.note,
					file: step.file,
					line: step.line,
					isHot: false,
				};
			});
			if (steps.length > 0) {
				causalSteps = steps;
			}
		}

		return {
			finding: a.finding,
			functionName: a.rep.functionName,
			objectType: a.rep.objectType,
			objectId: a.rep.objectId,
			appName: a.rep.appName,
			selfTimePercent: a.selfTimePercent,
			totalTimePercent: a.totalTimePercent,
			gapTime: a.gapTime > 0 ? a.gapTime : undefined,
			efficiencyScore: a.rep.efficiencyScore,
			frameCount: a.frameCount,
			status: a.status,
			attributionConfidence: a.attributionConfidence,
			// Weighted-only (R2-12): omit when the filtered union is empty — the
			// toPrioritized helper is only called for weighted findings; unweighted
			// rows use toUnweighted (no corroboration).
			...(perFindingPatterns.length > 0
				? { corroboratingPatterns: perFindingPatterns }
				: {}),
			// Weighted-only causal chain (R2-12): omit when evidencePath absent or empty.
			...(causalSteps !== undefined ? { causalSteps } : {}),
		};
	};

	// R2-12: `weighted` is self-time>0 ONLY. Filter on the SUMMED selfTimePercent
	// (after the ambiguous-frame accumulation), not per-frame — so an ambiguous
	// finding with frames {0, 5} sums to 5 and STAYS, while a finding whose every
	// hot frame has selfTime 0 (e.g. a matched orchestrator/dispatcher whose cost is
	// all in callees) sums to 0 and is DROPPED from weighted. Such zero-self matched
	// findings are NOT silently lost: they remain honestly visible via
	// `hotspotAnnotations` (in place on their hotspot) + `correlationSummary.matched`.
	// They are NOT rerouted into `unweighted` (that bucket is cold/orphan/unkeyable
	// only).
	const weighted = [...acc.values()]
		.map(toPrioritized)
		.filter((p) => p.selfTimePercent > 0)
		.sort(cmpPrioritized);

	// Unweighted bucket: cold + orphan + unkeyable findings (no runtime sample).
	// Each source array is tagged with its TRUE bucket — `blind-spot` here is a
	// structural placeholder for the required `status` field (none of these are a
	// real per-method correlation status); the honest signal is `bucket`, which
	// renderers MUST use to label the row. The cold/orphan/unkeyable distinction
	// survives on the row, not just in correlationSummary.
	const toUnweighted = (
		finding: FindingSummary,
		bucket: "cold" | "orphan" | "unkeyable",
	): PrioritizedFinding => ({
		finding,
		functionName: finding.primaryLocation.routineName ?? "",
		objectType: "",
		objectId: 0,
		appName: "",
		selfTimePercent: 0,
		totalTimePercent: 0,
		gapTime: undefined,
		efficiencyScore: 0,
		frameCount: 0,
		status: "blind-spot",
		attributionConfidence: "exact",
		bucket,
	});

	const unweighted: PrioritizedFinding[] = [
		...fused.coldFindings.map((f) => toUnweighted(f, "cold")),
		...fused.orphanFindings.map((f) => toUnweighted(f, "orphan")),
		...fused.unkeyableFindings.map((f) => toUnweighted(f, "unkeyable")),
	].sort((x, y) => {
		// (fingerprint, id) tiebreak via localeCompare — matches correlate.ts's
		// house determinism convention (intentional, byte-stable ordering).
		const fp = x.finding.fingerprint.localeCompare(y.finding.fingerprint);
		if (fp !== 0) return fp;
		return x.finding.id.localeCompare(y.finding.id);
	});

	return { weighted, unweighted };
}

// ---------------------------------------------------------------------------
// Total ordering for weighted findings (R2-3, R2-14)
// ---------------------------------------------------------------------------

/**
 * selfTime desc → totalTime desc → efficiencyScore desc → fingerprint → id.
 * Every field participates so ties always resolve deterministically.
 */
function cmpPrioritized(a: PrioritizedFinding, b: PrioritizedFinding): number {
	if (b.selfTimePercent !== a.selfTimePercent)
		return b.selfTimePercent - a.selfTimePercent;
	if (b.totalTimePercent !== a.totalTimePercent)
		return b.totalTimePercent - a.totalTimePercent;
	if (b.efficiencyScore !== a.efficiencyScore)
		return b.efficiencyScore - a.efficiencyScore;
	// (fingerprint, id) tiebreak via localeCompare — matches correlate.ts's house
	// determinism convention (intentional, byte-stable ordering).
	const fp = a.finding.fingerprint.localeCompare(b.finding.fingerprint);
	if (fp !== 0) return fp;
	return a.finding.id.localeCompare(b.finding.id);
}
