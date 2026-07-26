import type { SourceIndex, TableRelationInfo } from "../types/source-index.js";

/**
 * Build a table relationship graph from the source index.
 * Aggregates TableRelation and CalcFormula references between tables.
 */
export function buildTableRelationGraph(
	index: SourceIndex,
): TableRelationInfo[] {
	const relations: TableRelationInfo[] = [];

	// Reads the RESOLVED table, not the parsed objects. Walking objects
	// emitted `fromTable: obj.objectName`, which for a tableextension is the
	// extension's own name — every extension-declared relation was attributed
	// to a table that does not exist.
	for (const table of index.tables.values()) {
		// Two roots sharing a name are two different tables; a relation merged
		// across them describes neither.
		if (table.ambiguous) continue;

		// `fromTableId` is a required number and there is no root id to give
		// when only extensions were indexed. 0 is this index's marker for an
		// object with no id of its own — see `buildSourceIndex`'s object
		// keying, which falls back to `Type_Name` for exactly those. The
		// extension's own id would name the wrong object.
		const fromTableId = table.objectId ?? 0;

		for (const field of table.fields) {
			if (field.tableRelationTarget) {
				relations.push({
					fromTable: table.name,
					fromTableId,
					fromField: field.name,
					toTable: field.tableRelationTarget,
					relationType: "TableRelation",
					line: field.line,
				});
			}

			if (field.calcFormulaTable) {
				relations.push({
					fromTable: table.name,
					fromTableId,
					fromField: field.name,
					toTable: field.calcFormulaTable,
					relationType: "CalcFormula",
					line: field.line,
				});
			}
		}
	}

	return relations;
}

/**
 * Compute connectivity stats: which tables have the most relations.
 */
export function tableConnectivityStats(relations: TableRelationInfo[]): Array<{
	tableName: string;
	inbound: number;
	outbound: number;
	total: number;
}> {
	const stats = new Map<string, { inbound: number; outbound: number }>();

	const ensure = (name: string) => {
		if (!stats.has(name)) stats.set(name, { inbound: 0, outbound: 0 });
		return stats.get(name)!;
	};

	for (const r of relations) {
		ensure(r.fromTable).outbound++;
		ensure(r.toTable).inbound++;
	}

	return Array.from(stats.entries())
		.map(([tableName, s]) => ({
			tableName,
			inbound: s.inbound,
			outbound: s.outbound,
			total: s.inbound + s.outbound,
		}))
		.sort((a, b) => b.total - a.total);
}
