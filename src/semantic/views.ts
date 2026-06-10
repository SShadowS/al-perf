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
import type { FindingSummary } from "./contracts.js";
import { methodAttrKey } from "./correlate.js";

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
 * A static finding weighted by the runtime cost of the routine(s) it sits on.
 * Findings spanning N ambiguous frames have CPU summed across all frames (R2-8).
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
}

/**
 * JSON-safe carrier attached to AnalysisResult — NO Map/Set (R2-1).
 * Absent when fusion is off → existing output is byte-unchanged.
 */
export interface FusionViews {
	/** One annotation per AL hotspot, in methods[] order (R2-14). */
	hotspotAnnotations: HotspotAnnotation[];
	/** selfTime > 0 findings, ranked by selfTime desc (R2-3). */
	prioritizedFindings: PrioritizedFinding[];
	/** Cold/blind/unkeyable findings, weight 0, separate bucket (R2-12). */
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
 * Findings on cold/blind/unkeyable routines have no runtime sample →
 * `unweightedFindings`, never weighted/dropped (R2-12). Drives off the
 * ordered `methods[]` for determinism (R2-14).
 */
export function prioritizeFindings(
	fused: FusedModel,
	methods: MethodBreakdown[],
): { weighted: PrioritizedFinding[]; unweighted: PrioritizedFinding[] } {
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
			}
		}
	}

	const toPrioritized = (a: Acc): PrioritizedFinding => ({
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
	});

	const weighted = [...acc.values()].map(toPrioritized).sort(cmpPrioritized);

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
