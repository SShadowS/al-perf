import {
	classifySqlOperation,
	hasAggregate,
	hasReadUncommitted,
	isSqlFunctionName,
	isSqlNode,
	normalizeSqlShape,
	parseSqlTable,
} from "../core/sql-node.js";
import type { SqlActivityCorroboration } from "../output/types.js";
import type { ProfileMetadata } from "../types/batch.js";
import type {
	DetectedPattern,
	SqlStatementEvidence,
} from "../types/patterns.js";
import type { ProcessedNode, ProcessedProfile } from "../types/processed.js";
import { isAlRoutineFrameParts } from "./identity.js";

/** Bucket key for SQL with no resolvable owning routine. Never silently dropped. */
export const UNATTRIBUTED_KEY = "";

const TEXT_LIMIT = 200;

function isAlRoutineNode(node: ProcessedNode): boolean {
	return isAlRoutineFrameParts({
		functionName: node.callFrame.functionName,
		isBuiltin: node.isBuiltinCodeUnitCall === true,
	});
}

/** A SQL node's applicationDefinition self-identifies its issuer when populated. */
function hasValidObject(node: ProcessedNode): boolean {
	const { objectType, objectId, objectName } = node.applicationDefinition;
	return objectId >= 0 && objectType !== "" && objectName !== "";
}

/**
 * Map routine key (`${functionName}_${objectType}_${objectId}`, matching
 * aggregateByMethod in core/aggregator.ts) -> SQL that routine issued.
 *
 * Owning routine of a SQL node:
 *  - functionName ALWAYS comes from the nearest AL-routine ancestor (a SQL
 *    node carries no routine name of its own — its functionName IS the SQL).
 *  - object part: the SQL node's own applicationDefinition when valid
 *    (self-identification, attribution "object-method"), else the ancestor's
 *    object (attribution "ancestor-fallback").
 *  - no AL ancestor at all -> UNATTRIBUTED_KEY bucket.
 *
 * All counts/costs are SAMPLED (hitCount is a sample count on sampling
 * profiles) — identical normalized shapes merge, sums accumulate.
 */
export function buildSqlByRoutine(
	profile: ProcessedProfile,
): Map<string, SqlStatementEvidence[]> {
	// key -> shape -> evidence
	const byRoutine = new Map<string, Map<string, SqlStatementEvidence>>();

	for (const node of profile.allNodes) {
		if (!isSqlNode(node)) continue;

		// Nearest AL-routine ancestor supplies the routine name.
		let ancestor: ProcessedNode | undefined = node.parent;
		while (ancestor && !isAlRoutineNode(ancestor)) ancestor = ancestor.parent;

		let key: string;
		let attribution: SqlStatementEvidence["attribution"];
		if (!ancestor) {
			key = UNATTRIBUTED_KEY;
			attribution = "ancestor-fallback";
		} else if (hasValidObject(node)) {
			const { objectType, objectId } = node.applicationDefinition;
			key = `${ancestor.callFrame.functionName}_${objectType}_${objectId}`;
			attribution = "object-method";
		} else {
			const { objectType, objectId } = ancestor.applicationDefinition;
			key = `${ancestor.callFrame.functionName}_${objectType}_${objectId}`;
			attribution = "ancestor-fallback";
		}

		const sql = node.callFrame.functionName;
		const shape = normalizeSqlShape(sql);
		let shapes = byRoutine.get(key);
		if (!shapes) {
			shapes = new Map();
			byRoutine.set(key, shapes);
		}
		const existing = shapes.get(shape);
		if (existing) {
			existing.sampledHitCount += node.hitCount;
			existing.sampledCostUs += node.selfTime;
		} else {
			const parsedTable = parseSqlTable(sql);
			shapes.set(shape, {
				text: shape.length > TEXT_LIMIT ? shape.slice(0, TEXT_LIMIT) : shape,
				operation: classifySqlOperation(sql),
				table: parsedTable.table,
				extensionAppId: parsedTable.extensionAppId,
				readUncommitted: hasReadUncommitted(sql),
				sampledHitCount: node.hitCount,
				sampledCostUs: node.selfTime,
				attribution,
			});
		}
	}

	const result = new Map<string, SqlStatementEvidence[]>();
	for (const [key, shapes] of byRoutine) {
		result.set(
			key,
			Array.from(shapes.values()).sort(
				(a, b) => b.sampledCostUs - a.sampledCostUs,
			),
		);
	}
	return result;
}

/**
 * Parse a detector display label `"FunctionName (ObjectType ObjectId)"` back
 * into a routine key. Same grammar as LABEL_RE in lifecycle/wire.ts (greedy
 * first group — only the LAST " (" starts the object suffix). Duplicated here
 * (one line) rather than importing lifecycle into semantic.
 */
const LABEL_RE = /^(.+) \((\S+) (\d+)\)$/;

function routineKeyFromLabel(label: string): string | null {
	const m = LABEL_RE.exec(label);
	if (!m) return null;
	if (isSqlFunctionName(m[1])) return null; // SQL frame label — not a routine
	return `${m[1]}_${m[2]}_${m[3]}`;
}

const isDml = (s: SqlStatementEvidence): boolean =>
	s.operation === "INSERT" ||
	s.operation === "UPDATE" ||
	s.operation === "DELETE";

/**
 * Which statements count as evidence per pattern id. Absent id = no signal
 * (same discipline as CORROBORATION_MAP). NOTE: unlike CORROBORATION_MAP's
 * anchorIndex (which names the LOOP OWNER), evidence needs the SQL ISSUER —
 * we union across all routine entries instead of picking an index.
 */
export const SQL_EVIDENCE_OPS: Record<
	string,
	(s: SqlStatementEvidence) => boolean
> = {
	"missing-setloadfields": (s) => s.operation === "SELECT",
	"incomplete-setloadfields": (s) => s.operation === "SELECT",
	"unfiltered-findset": (s) => s.operation === "SELECT",
	"unindexed-filter": (s) => s.operation === "SELECT",
	"calcfields-in-loop": (s) =>
		(s.operation === "SELECT" || s.operation === "COUNT") &&
		hasAggregate(s.text),
	"modify-in-loop": (s) => s.operation === "UPDATE",
	"insert-in-loop": (s) => s.operation === "INSERT",
	"delete-in-loop": (s) => s.operation === "DELETE",
	"record-op-in-loop": isDml,
	"high-hit-count": () => true,
	"repeated-siblings": () => true,
};

const DISPLAY_LIMIT = 5;

/**
 * Attach SQL evidence + sqlRank to each finding. Mutates ONLY sqlEvidence and
 * sqlRank — never impact, fingerprint, or any identity field. Silent when
 * nothing matches.
 */
export function attachSqlEvidence(
	patterns: DetectedPattern[],
	sqlByRoutine: Map<string, SqlStatementEvidence[]>,
): void {
	for (const pattern of patterns) {
		const filter = SQL_EVIDENCE_OPS[pattern.id];
		if (!filter) continue;

		// Union across every involvedMethods entry that is a real routine.
		const seen = new Set<string>();
		const matched: SqlStatementEvidence[] = [];
		for (const label of pattern.involvedMethods) {
			const key = routineKeyFromLabel(label);
			if (key === null || seen.has(key)) continue;
			seen.add(key);
			for (const item of sqlByRoutine.get(key) ?? []) {
				if (filter(item)) matched.push(item);
			}
		}
		if (matched.length === 0) continue;

		// Totals from the FULL set; truncate only the display list.
		let totalCost = 0;
		let totalHits = 0;
		const attributions = new Set<string>();
		for (const s of matched) {
			totalCost += s.sampledCostUs;
			totalHits += s.sampledHitCount;
			attributions.add(s.attribution);
		}
		const sorted = [...matched].sort(
			(a, b) => b.sampledCostUs - a.sampledCostUs,
		);

		pattern.sqlEvidence = {
			statements: sorted.slice(0, DISPLAY_LIMIT),
			totalSampledCostUs: totalCost,
			totalSampledHitCount: totalHits,
			provenance: "sampled-estimate",
			attribution:
				attributions.size > 1
					? "mixed"
					: (attributions.values().next().value as
							| "object-method"
							| "ancestor-fallback"),
		};
		pattern.sqlRank = totalCost;
	}
}

/**
 * Activity-level corroboration: the manifest's MEASURED SQL count/duration
 * beside the profile's SAMPLED SQL total. No subtraction across manifest
 * duration fields — they overlap (alExecutionDuration includes HTTP wait).
 */
export function buildSqlActivityCorroboration(
	sqlByRoutine: Map<string, SqlStatementEvidence[]>,
	metadata: ProfileMetadata,
): SqlActivityCorroboration {
	let sampled = 0;
	for (const items of sqlByRoutine.values()) {
		for (const item of items) sampled += item.sampledCostUs;
	}
	return {
		measuredSqlCount: metadata.sqlCallCount,
		measuredSqlDurationMs: metadata.sqlCallDuration,
		sampledAttributedCostUs: sampled,
		activityDurationMs: metadata.activityDuration,
		alExecutionDurationMs: metadata.alExecutionDuration,
	};
}
