import {
	classifySqlOperation,
	hasReadUncommitted,
	isSqlNode,
	normalizeSqlShape,
	parseSqlTable,
} from "../core/sql-node.js";
import type { SqlStatementEvidence } from "../types/patterns.js";
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
