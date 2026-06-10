/**
 * correlate.ts — Pure identity-correlation layer for the al-perf × al-sem fusion.
 *
 * `correlate(methods, engine) → FusedModel`
 *
 * Joins al-perf's runtime `MethodBreakdown[]` against al-sem's static
 * `EngineAnalysis` (routine inventory + findings) by normalised
 * `(canonicalObjectType, objectNumber, normalizeTriggerName(routineName))`.
 *
 * PURE — no I/O, no filesystem access, no subprocess calls.
 *
 * Honesty contract (R2-D/E — the integrity spine):
 *   matched       — exactly one universe routine; exact confidence.
 *   matched-clean — same, but zero findings attached.
 *   ambiguous     — ≥2 universe routines share the join key (overloads);
 *                   UNION of findings; confidence="ambiguous".
 *                   NEVER rendered as "caused by X" — the union means "one of
 *                   these may apply".
 *   blind-spot    — the AL method is not in the universe; reason recorded.
 *   cold          — universe routine with NO runtime sample (workspace-level).
 *   unkeyable     — finding with no routineName or unparseable objectId;
 *                   in its own bucket, NEVER folded into cold.
 */

import type { MethodBreakdown } from "../types/aggregated.js";
// P3 ENHANCEMENT (tracked): precise field/control-level trigger correlation
// needs al-sem to expose each trigger's enclosing field/control name in the
// inventory, so the join key can be (objType, num, field, trigger) rather than
// collapsing to (objType, num, bare-trigger). Until then, two fields on the
// same object each having (say) an OnValidate trigger collide on the same join
// key and are honestly reported as `ambiguous` (we cannot tell field-A's
// OnValidate from field-B's from the profile's bare name alone). See the
// collision handling in the `universeEntries.length > 1` branch below.
import type {
	CorrelationSummary,
	FusedModel,
	SemanticAttribution,
} from "../types/fused.js";
import type {
	CoverageEntry,
	FindingSummary,
	RoutineIdentity,
} from "./contracts.js";
import type { EngineAnalysis } from "./engine-runner.js";
import {
	canonicalObjectType,
	isAlRoutineFrame,
	normalizeTriggerName,
	parseObjectId,
} from "./identity.js";

// ---------------------------------------------------------------------------
// Join-key helpers
// ---------------------------------------------------------------------------

/** A stable 3-tuple key for the join. Stored as a string for Map use. */
type JoinKey = string; // `${canonicalType}|${objectNumber}|${routineName}`

function makeJoinKey(
	objectType: string,
	objectNumber: number,
	routineName: string,
): JoinKey {
	return `${canonicalObjectType(objectType)}|${objectNumber}|${routineName}`;
}

function makeMethodJoinKey(m: MethodBreakdown): JoinKey {
	return makeJoinKey(
		m.objectType,
		m.objectId,
		normalizeTriggerName(m.functionName),
	);
}

function makeRoutineJoinKey(r: RoutineIdentity): JoinKey {
	return makeJoinKey(r.objectType, r.objectNumber, r.routineName);
}

/** al-perf's canonical method attribution key. */
export function methodAttrKey(m: MethodBreakdown): string {
	return `${m.functionName}_${m.objectType}_${m.objectId}`;
}

// ---------------------------------------------------------------------------
// Determinism: sort findings by (fingerprint, id)
// ---------------------------------------------------------------------------

function sortFindings(findings: FindingSummary[]): FindingSummary[] {
	return [...findings].sort((a, b) => {
		const fp = a.fingerprint.localeCompare(b.fingerprint);
		if (fp !== 0) return fp;
		return a.id.localeCompare(b.id);
	});
}

// ---------------------------------------------------------------------------
// Build the universe multimap (join key → RoutineIdentity[])
// ---------------------------------------------------------------------------

function buildUniverseMap(
	routines: RoutineIdentity[],
): Map<JoinKey, RoutineIdentity[]> {
	const map = new Map<JoinKey, RoutineIdentity[]>();
	for (const r of routines) {
		const key = makeRoutineJoinKey(r);
		const list = map.get(key) ?? [];
		list.push(r);
		map.set(key, list);
	}
	return map;
}

// ---------------------------------------------------------------------------
// Build the findings multimap (join key → FindingSummary[])
// Findings with no routineName or unparseable objectId → unkeyable bucket
// ---------------------------------------------------------------------------

interface FindingsIndex {
	/** Keyable findings grouped by their join key. */
	byKey: Map<JoinKey, FindingSummary[]>;
	/** Findings that cannot be given a join key. */
	unkeyable: FindingSummary[];
}

function buildFindingsIndex(findings: FindingSummary[]): FindingsIndex {
	const byKey = new Map<JoinKey, FindingSummary[]>();
	const unkeyable: FindingSummary[] = [];

	for (const f of findings) {
		const loc = f.primaryLocation;

		// A finding without a routineName cannot be joined.
		if (!loc.routineName) {
			unkeyable.push(f);
			continue;
		}

		// A finding whose objectId cannot be parsed cannot be joined.
		if (!loc.objectId) {
			unkeyable.push(f);
			continue;
		}
		const parsed = parseObjectId(loc.objectId);
		if (!parsed) {
			unkeyable.push(f);
			continue;
		}

		const key = makeJoinKey(
			parsed.objectType,
			parsed.objectNumber,
			loc.routineName,
		);
		const list = byKey.get(key) ?? [];
		list.push(f);
		byKey.set(key, list);
	}

	return { byKey, unkeyable };
}

// ---------------------------------------------------------------------------
// Coverage-subject parsing
//
// A coverage subject is a colon-form StableRoutineId:
//   `<appGuid>:<objectType>:<objectNumber>#<hash>`  (routine-scoped)  OR
//   `<appGuid>:<objectType>:<objectNumber>`         (object-scoped)
// The objectType is in al-sem AL-keyword case already, but we canonicalise it
// defensively so comparisons are case-stable.
// ---------------------------------------------------------------------------

interface ParsedSubject {
	objectType: string; // canonicalised
	objectNumber: string; // kept as string for exact comparison
}

function parseCoverageSubject(subject: string): ParsedSubject | null {
	const parts = subject.split(":");
	if (parts.length < 3) return null;
	const objectType = canonicalObjectType(parts[1] ?? "");
	// The third segment may carry a "#hash" suffix.
	const objectNumber = (parts[2] ?? "").split("#")[0];
	if (!objectType || !objectNumber) return null;
	return { objectType, objectNumber };
}

/**
 * Return `true` if any coverage subject is for the SAME (objectType, objectNumber)
 * as the method — i.e. al-sem actually analyzed this object (not just any object
 * that happens to share the number). The objectType cross-check fixes the bug
 * where a hot `Page 50100` was falsely "covered" because `Codeunit 50100` was.
 */
function objectIsCovered(
	m: MethodBreakdown,
	coverageSubjects: string[],
): boolean {
	const wantType = canonicalObjectType(m.objectType);
	const wantNum = String(m.objectId);
	return coverageSubjects.some((s) => {
		const parsed = parseCoverageSubject(s);
		if (!parsed) return false;
		return parsed.objectType === wantType && parsed.objectNumber === wantNum;
	});
}

// ---------------------------------------------------------------------------
// Blind-spot reason derivation (objectType + objectNumber cross-checked)
// ---------------------------------------------------------------------------

function blindSpotReason(
	m: MethodBreakdown,
	coverageSubjects: string[],
): string {
	// We know isAlRoutineFrame(m) is true at this point.
	if (objectIsCovered(m, coverageSubjects)) {
		return `routine not found in the analyzed app (${m.objectType} ${m.objectId} was analyzed but routine "${m.functionName}" is absent from the inventory)`;
	}
	return `object ${m.objectType} ${m.objectId} was not analyzed (not in the workspace or is an opaque dependency)`;
}

// ---------------------------------------------------------------------------
// Matched-clean coverage gating
//
// "Zero findings" only means "verified clean" when al-sem actually analyzed the
// routine's BODY. Under degraded coverage — the object is in `opaqueApps`, or
// its CoverageEntry directStatus/inheritedStatus is not "complete" — zero
// findings means "couldn't analyze", NOT "clean". We gate matchedClean on a
// fully-analyzed context.
// ---------------------------------------------------------------------------

/**
 * Is the routine's object in a FULLY-ANALYZED context?
 *
 *  - false if global coverage is degraded by an opaque app covering this object
 *    (we can't cheaply map objectNumber→appGuid, so any opaqueApps + this object
 *    not provably "complete" is treated conservatively as not-fully-analyzed).
 *  - Requires at least one CoverageEntry for this (objectType, objectNumber)
 *    whose directStatus AND inheritedStatus are both "complete".
 *  - If there is NO coverage entry for the object at all, we cannot claim full
 *    analysis → not fully analyzed (conservative).
 */
function routineFullyAnalyzed(
	objectType: string,
	objectNumber: number,
	coverage: CoverageEntry[],
	opaqueApps: string[],
): boolean {
	const wantType = canonicalObjectType(objectType);
	const wantNum = String(objectNumber);

	// Find coverage entries for this object.
	const entries = coverage.filter((c) => {
		const parsed = parseCoverageSubject(c.subject);
		if (!parsed) return false;
		return parsed.objectType === wantType && parsed.objectNumber === wantNum;
	});

	if (entries.length === 0) return false;

	// Every matching entry must be fully complete (direct + inherited).
	const allComplete = entries.every(
		(c) => c.directStatus === "complete" && c.inheritedStatus === "complete",
	);
	if (!allComplete) return false;

	// Conservative: if there are opaque apps AND we cannot prove this object is
	// outside them (no appGuid mapping available cheaply), require the global
	// coverage to be non-degraded. opaqueApps non-empty → degraded.
	if (opaqueApps.length > 0) return false;

	return true;
}

// ---------------------------------------------------------------------------
// Main entry point: correlate
// ---------------------------------------------------------------------------

/**
 * Join al-perf runtime hotspot methods against al-sem static analysis.
 *
 * Pure function — no I/O, no filesystem, no subprocess calls.
 *
 * @param methods  The al-perf `MethodBreakdown[]` from the profiled run.
 * @param engine   The `EngineAnalysis` from the engine-runner (fingerprint + analyze).
 * @returns        A `FusedModel` side-map + workspace-level metadata.
 */
export function correlate(
	methods: MethodBreakdown[],
	engine: EngineAnalysis,
): FusedModel {
	// Build lookup structures.
	const universeMap = buildUniverseMap(engine.routines);
	const { byKey: findingsMap, unkeyable: unkeyableFindings } =
		buildFindingsIndex(engine.findings);

	// Track which universe keys have been "hit" by at least one method.
	const hitUniverseKeys = new Set<JoinKey>();

	// Build the attribution side-map.
	const attributions = new Map<string, SemanticAttribution>();

	let matched = 0;
	let matchedClean = 0;
	let ambiguous = 0;
	let blindSpot = 0;

	for (const m of methods) {
		// Filter non-AL frames before the join (SQL statements, builtins).
		if (!isAlRoutineFrame(m)) continue;

		const attrKey = methodAttrKey(m);
		const joinKey = makeMethodJoinKey(m);

		const universeEntries = universeMap.get(joinKey);

		if (!universeEntries || universeEntries.length === 0) {
			// blind-spot
			attributions.set(attrKey, {
				status: "blind-spot",
				findings: [],
				attributionConfidence: "exact", // "exact" in the sense: exactly one status
				reason: blindSpotReason(m, engine.coverageSubjects),
			});
			blindSpot++;
			continue;
		}

		// Mark the universe key as hit.
		hitUniverseKeys.add(joinKey);

		// Gather all findings for this key.
		const rawFindings = findingsMap.get(joinKey) ?? [];

		if (universeEntries.length === 1) {
			// Exactly one universe routine — exact match.
			const routine = universeEntries[0];
			const sortedFindings = sortFindings(rawFindings);
			const hasNoFindings = sortedFindings.length === 0;

			// matchedClean OVER-CLAIMS safety unless the routine's body was fully
			// analyzed. Zero findings under degraded/incomplete coverage means
			// "couldn't analyze", not "verified clean". Gate accordingly.
			const fullyAnalyzed = routineFullyAnalyzed(
				routine.objectType,
				routine.objectNumber,
				engine.coverage,
				engine.opaqueApps,
			);
			const isClean = hasNoFindings && fullyAnalyzed;

			attributions.set(attrKey, {
				status: "matched",
				findings: sortedFindings,
				attributionConfidence: "exact",
				matchedClean: isClean ? true : undefined,
				stableRoutineId: routine.stableRoutineId,
				// When matched with no findings BUT coverage is incomplete, be
				// honest: it's matched, not verified-clean.
				reason:
					hasNoFindings && !fullyAnalyzed
						? "matched; coverage incomplete (no findings, but the routine body was not fully analyzed — not verified clean)"
						: undefined,
			});
			matched++;
			if (isClean) matchedClean++;
		} else {
			// Multiple universe routines → ambiguous (overloads OR colliding
			// field/control triggers that share a bare trigger name).
			// Attach the UNION of findings (all share this join key, so rawFindings
			// already IS the union — the findings multimap keys on the same tuple).
			const unionFindings = sortFindings(rawFindings);
			const stableIds = universeEntries.map((r) => r.stableRoutineId);

			// HONEST reason: they share the NORMALIZED join name, NOT the
			// unstripped profile functionName. For a field-trigger collision the
			// unstripped name (e.g. "Field A - OnValidate") is NOT what they share;
			// the shared key is the bare trigger ("OnValidate").
			const sharedName = normalizeTriggerName(m.functionName);

			attributions.set(attrKey, {
				status: "ambiguous",
				findings: unionFindings,
				attributionConfidence: "ambiguous",
				stableRoutineId: stableIds,
				reason: `${universeEntries.length} routines resolve to "${sharedName}" on ${canonicalObjectType(m.objectType)} ${m.objectId} (overloads or field/control triggers sharing a bare name); attribution is ambiguous`,
			});
			ambiguous++;
		}
	}

	// Compute cold: universe routines whose join key was never hit.
	const coldRoutines: RoutineIdentity[] = [];
	for (const [key, routines] of universeMap) {
		if (!hitUniverseKeys.has(key)) {
			for (const r of routines) {
				coldRoutines.push(r);
			}
		}
	}
	const coldCount = coldRoutines.length;

	// Cold findings vs orphan findings:
	//  - cold      = finding whose key is IN the universe but has no runtime
	//                sample (a true cold routine: statically flagged, not hot).
	//  - orphan    = finding whose key is NOT in the universe at all (its routine
	//                is absent from the inventory). These are NOT cold — calling
	//                them cold would imply they belong to a known-but-unsampled
	//                routine. Route them to a distinct bucket so coldFindings
	//                stays consistent with coldCount (which counts only universe
	//                routines).
	const coldFindings: FindingSummary[] = [];
	const orphanFindings: FindingSummary[] = [];
	for (const [key, findings] of findingsMap) {
		if (hitUniverseKeys.has(key)) continue; // attributed to a hot method already
		if (universeMap.has(key)) {
			// In-universe but no runtime sample → genuinely cold.
			for (const f of findings) coldFindings.push(f);
		} else {
			// Keyed, but no universe routine → orphan (routine absent from inventory).
			for (const f of findings) orphanFindings.push(f);
		}
	}

	// Mismatch detection: zero intersection over a non-trivial AL method set.
	// "Non-trivial" = at least 1 AL routine frame in the method list.
	const alMethods = methods.filter(isAlRoutineFrame);
	let mismatch: FusedModel["mismatch"];
	if (alMethods.length > 0 && hitUniverseKeys.size === 0) {
		mismatch = {
			reason:
				"Zero correlation between the profiled methods and the analyzed workspace — " +
				"the --source directory likely doesn't match the profiled app. " +
				`Workspace app: ${engine.primaryApp?.name ?? "(unknown)"} by ${engine.primaryApp?.publisher ?? "(unknown)"}.`,
		};
	}

	const correlationSummary: CorrelationSummary = {
		matched,
		matchedClean,
		ambiguous,
		blindSpot,
		coldCount,
		unkeyableCount: unkeyableFindings.length,
		orphanCount: orphanFindings.length,
	};

	// Deterministic ordering for ALL emitted finding lists + the cold routine list.
	const sortRoutines = (rs: RoutineIdentity[]): RoutineIdentity[] =>
		[...rs].sort((a, b) => a.stableRoutineId.localeCompare(b.stableRoutineId));

	return {
		attributions,
		coldRoutines: sortRoutines(coldRoutines),
		coldFindings: sortFindings(coldFindings),
		orphanFindings: sortFindings(orphanFindings),
		unkeyableFindings: sortFindings(unkeyableFindings),
		coverage: engine.coverage,
		correlationSummary,
		mismatch,
		engine: {
			alsemVersion: engine.alsemVersion,
			primaryApp: engine.primaryApp,
			diagnostics: engine.diagnostics,
		},
	};
}
