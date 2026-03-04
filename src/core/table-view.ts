import type { ProcessedProfile } from "../types/processed.js";
import type { SourceIndex } from "../types/source-index.js";
import type { TableBreakdown, TableOperationBreakdown } from "../output/types.js";
import { isIdleNode } from "./processor.js";

/**
 * Build a table-centric performance breakdown.
 *
 * Strategy:
 * 1. Profile nodes with objectType containing "Table" (e.g., "TableData", "Table")
 *    contribute directly by their function name (which IS the operation: "FindSet", "Modify", etc.)
 * 2. Source index provides: which record variables map to which tables, SetLoadFields/filter usage
 */
export function buildTableBreakdown(
  profile: ProcessedProfile,
  sourceIndex?: SourceIndex,
): TableBreakdown[] {
  // Aggregate profile nodes by table
  const tableMap = new Map<string, {
    selfTime: number;
    ops: Map<string, { selfTime: number; hitCount: number }>;
    callSites: Set<string>;
  }>();

  for (const node of profile.allNodes) {
    if (isIdleNode(node)) continue;
    const { objectType, objectName } = node.applicationDefinition;
    // Profile nodes that represent table operations have objectType like "TableData"
    if (!objectType.toLowerCase().includes("table")) continue;

    const tableName = objectName || "(Unknown Table)";
    let entry = tableMap.get(tableName);
    if (!entry) {
      entry = { selfTime: 0, ops: new Map(), callSites: new Set() };
      tableMap.set(tableName, entry);
    }

    entry.selfTime += node.selfTime;

    const opName = node.callFrame.functionName;
    let opEntry = entry.ops.get(opName);
    if (!opEntry) {
      opEntry = { selfTime: 0, hitCount: 0 };
      entry.ops.set(opName, opEntry);
    }
    opEntry.selfTime += node.selfTime;
    opEntry.hitCount += node.hitCount;

    // Track which parent methods call into this table
    if (node.parent) {
      const parentRef = `${node.parent.callFrame.functionName}:${node.parent.applicationDefinition.objectId}`;
      entry.callSites.add(parentRef);
    }
  }

  // Build source-side info
  const sourceInfo = new Map<string, { hasSetLoadFields: boolean; hasFilters: boolean }>();
  if (sourceIndex) {
    for (const obj of sourceIndex.objects.values()) {
      const members = [...obj.procedures, ...obj.triggers];
      for (const member of members) {
        for (const op of member.features.recordOps) {
          if (!op.recordVariable) continue;
          const variable = member.features.variables.find(
            v => v.name.toLowerCase() === op.recordVariable!.toLowerCase()
          );
          if (!variable?.isRecord || !variable.tableName) continue;
          const tableName = variable.tableName;
          let info = sourceInfo.get(tableName);
          if (!info) {
            info = { hasSetLoadFields: false, hasFilters: false };
            sourceInfo.set(tableName, info);
          }
          if (op.type === "SetLoadFields") info.hasSetLoadFields = true;
          if (op.type === "SetRange" || op.type === "SetFilter") info.hasFilters = true;
        }
      }
    }
  }

  // Combine into results
  const results: TableBreakdown[] = [];
  for (const [tableName, entry] of tableMap) {
    const operationBreakdown: TableOperationBreakdown[] = Array.from(entry.ops.entries())
      .map(([operation, data]) => ({
        operation,
        selfTime: data.selfTime,
        hitCount: data.hitCount,
      }))
      .sort((a, b) => b.selfTime - a.selfTime);

    const si = sourceInfo.get(tableName);

    results.push({
      tableName,
      totalSelfTime: entry.selfTime,
      totalSelfTimePercent: profile.activeSelfTime > 0
        ? (entry.selfTime / profile.activeSelfTime) * 100
        : 0,
      operationBreakdown,
      callSiteCount: entry.callSites.size,
      hasSetLoadFields: si?.hasSetLoadFields ?? false,
      hasFilters: si?.hasFilters ?? false,
    });
  }

  return results.sort((a, b) => b.totalSelfTime - a.totalSelfTime);
}
