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
import type {
	CorrelationSummary,
	FusedModel,
	SemanticAttribution,
} from "../types/fused.js";
import type { MethodBreakdown } from "../types/aggregated.js";

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
function methodAttrKey(m: MethodBreakdown): string {
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
// Blind-spot reason derivation
// ---------------------------------------------------------------------------

function blindSpotReason(
	m: MethodBreakdown,
	coverageSubjects: string[],
): string {
	// We know isAlRoutineFrame(m) is true at this point.
	// Check coverage subjects (StableRoutineIds) for the object number.
	// A coverage subject looks like `<appGuid>:Codeunit:<objectNumber>#<hash>`.
	const objNumStr = String(m.objectId);
	const hasInCoverage = coverageSubjects.some((s) => {
		// Extract the objectNumber segment from the colon-form StableRoutineId.
		// Form: appGuid:objectType:objectNumber#hash  OR  appGuid:objectType:objectNumber
		const parts = s.split(":");
		if (parts.length < 3) return false;
		// The third segment may have a "#hash" suffix.
		const numPart = (parts[2] ?? "").split("#")[0];
		return numPart === objNumStr;
	});

	if (hasInCoverage) {
		return `routine not found in the analyzed app (object ${m.objectId} is covered but routine "${m.functionName}" is absent from the inventory)`;
	}

	return `object ${m.objectType} ${m.objectId} was not analyzed (not in the workspace or is an opaque dependency)`;
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
			const isClean = sortedFindings.length === 0;

			attributions.set(attrKey, {
				status: "matched",
				findings: sortedFindings,
				attributionConfidence: "exact",
				matchedClean: isClean ? true : undefined,
				stableRoutineId: routine.stableRoutineId,
			});
			matched++;
			if (isClean) matchedClean++;
		} else {
			// Multiple universe routines → ambiguous (overloads).
			// Attach the UNION of findings from ALL overloads' keys.
			// Since all overloads share the same join key, rawFindings is already
			// the union (the findings multimap keys on the same 3-tuple).
			const unionFindings = sortFindings(rawFindings);
			const stableIds = universeEntries.map((r) => r.stableRoutineId);

			attributions.set(attrKey, {
				status: "ambiguous",
				findings: unionFindings,
				attributionConfidence: "ambiguous",
				stableRoutineId: stableIds,
				reason: `${universeEntries.length} overloaded routines share the name "${m.functionName}" on object ${m.objectType} ${m.objectId}`,
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

	// Cold findings: findings attached to cold universe routines.
	const coldFindings: FindingSummary[] = [];
	for (const [key, findings] of findingsMap) {
		if (!hitUniverseKeys.has(key)) {
			for (const f of findings) {
				coldFindings.push(f);
			}
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
	};

	return {
		attributions,
		coldFindings: sortFindings(coldFindings),
		unkeyableFindings,
		coverage: engine.coverage as CoverageEntry[],
		correlationSummary,
		mismatch,
		engine: {
			alsemVersion: engine.alsemVersion,
			primaryApp: engine.primaryApp,
			diagnostics: engine.diagnostics,
		},
	};
}
