import type { SourceIndex, TableRelationInfo } from "../types/source-index.js";

/**
 * Build a table relationship graph from the source index.
 * Aggregates TableRelation and CalcFormula references between tables.
 */
export function buildTableRelationGraph(index: SourceIndex): TableRelationInfo[] {
  const relations: TableRelationInfo[] = [];

  for (const obj of index.objects.values()) {
    if (obj.objectType !== "Table" && obj.objectType !== "TableExtension") continue;

    for (const field of obj.fields) {
      // TableRelation references
      if (field.tableRelationTarget) {
        relations.push({
          fromTable: obj.objectName,
          fromTableId: obj.objectId,
          fromField: field.name,
          toTable: field.tableRelationTarget,
          relationType: "TableRelation",
          line: field.line,
        });
      }

      // CalcFormula references
      if (field.calcFormulaTable) {
        relations.push({
          fromTable: obj.objectName,
          fromTableId: obj.objectId,
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
