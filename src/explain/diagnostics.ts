import type { ProcessedNode, ProcessedProfile } from "../types/processed.js";
import type { AnalysisResult } from "../output/types.js";
import { isIdleNode } from "../core/processor.js";

export interface TableAccessEntry {
  table: string;
  totalHitCount: number;
  totalSelfTime: number;
  accessedBy: Array<{ method: string; objectType: string; objectId: number; hitCount: number }>;
}

export interface ProfileDiagnostics {
  coldCacheScore: number;
  coldCacheWarning: boolean;
  wallClockGapRatio: number | null;
  wallClockGapNote: string | null;
  transactionCount: number;
  tableAccessMap: TableAccessEntry[];
  healthScoreNote: string | null;
}

const METADATA_TABLES = new Set([
  "application object metadata",
  "translation text",
  "permission",
  "permission set",
  "tenant permission",
  "tenant permission set",
  "access control",
  "metadata",
]);

function isMetadataTable(objectName: string): boolean {
  return METADATA_TABLES.has(objectName.toLowerCase());
}

function isTableNode(node: ProcessedNode): boolean {
  return node.applicationDefinition.objectType.toLowerCase().includes("table");
}

/**
 * Compute a unique caller key from a node's parent.
 * Returns the parent's functionName + objectType + objectId to identify distinct callers.
 */
function callerKey(parent: ProcessedNode): string {
  return `${parent.callFrame.functionName}|${parent.applicationDefinition.objectType}|${parent.applicationDefinition.objectId}`;
}

export function computeDiagnostics(
  profile: ProcessedProfile,
  result: AnalysisResult,
): ProfileDiagnostics {
  // 1. Cold cache score
  let metadataSelfTime = 0;
  for (const node of profile.allNodes) {
    if (isIdleNode(node)) continue;
    if (isTableNode(node) && isMetadataTable(node.applicationDefinition.objectName)) {
      metadataSelfTime += node.selfTime;
    }
  }
  const coldCacheScore = profile.activeSelfTime > 0 ? metadataSelfTime / profile.activeSelfTime : 0;
  const coldCacheWarning = coldCacheScore > 0.4;

  // 2. Wall-clock gap ratio
  let wallClockGapRatio: number | null = null;
  let wallClockGapNote: string | null = null;
  if (profile.type === "instrumentation" && profile.totalDuration > 0) {
    wallClockGapRatio = (profile.totalDuration - profile.activeSelfTime) / profile.totalDuration;
    if (wallClockGapRatio > 0.5) {
      wallClockGapNote = `Wall-clock gap ratio is ${(wallClockGapRatio * 100).toFixed(0)}% — significant time is spent outside measured AL code, likely due to SQL wait time or lock contention.`;
    }
  }

  // 3. Transaction count
  let transactionCount = 0;
  for (const node of profile.allNodes) {
    if (node.callFrame.functionName === "BeginTransaction") {
      transactionCount += node.hitCount;
    }
  }

  // 4. Table access map
  const tableMap = new Map<string, {
    totalHitCount: number;
    totalSelfTime: number;
    callers: Map<string, { method: string; objectType: string; objectId: number; hitCount: number }>;
  }>();

  for (const node of profile.allNodes) {
    if (!isTableNode(node)) continue;
    const tableName = node.applicationDefinition.objectName;
    if (isMetadataTable(tableName)) continue;
    if (!node.parent) continue;

    let entry = tableMap.get(tableName);
    if (!entry) {
      entry = { totalHitCount: 0, totalSelfTime: 0, callers: new Map() };
      tableMap.set(tableName, entry);
    }
    entry.totalHitCount += node.hitCount;
    entry.totalSelfTime += node.selfTime;

    const key = callerKey(node.parent);
    const existing = entry.callers.get(key);
    if (existing) {
      existing.hitCount += node.hitCount;
    } else {
      entry.callers.set(key, {
        method: node.parent.callFrame.functionName,
        objectType: node.parent.applicationDefinition.objectType,
        objectId: node.parent.applicationDefinition.objectId,
        hitCount: node.hitCount,
      });
    }
  }

  const tableAccessMap: TableAccessEntry[] = [];
  for (const [table, entry] of tableMap) {
    if (entry.callers.size < 2) continue;
    const accessedBy = Array.from(entry.callers.values()).sort((a, b) => b.hitCount - a.hitCount);
    tableAccessMap.push({
      table,
      totalHitCount: entry.totalHitCount,
      totalSelfTime: entry.totalSelfTime,
      accessedBy,
    });
  }
  tableAccessMap.sort((a, b) => b.totalHitCount - a.totalHitCount);
  // Cap to top 10 to avoid inflating token count
  if (tableAccessMap.length > 10) tableAccessMap.length = 10;

  // 5. Health score note
  const { healthScore, patternCount } = result.summary;
  const totalPatterns = patternCount.critical + patternCount.warning + patternCount.info;
  let healthScoreNote: string | null = null;
  if (healthScore < 30 && totalPatterns > 20) {
    healthScoreNote = `Health score (${healthScore}) is driven by high pattern count (${totalPatterns}) and may be misleading.`;
  }

  return {
    coldCacheScore,
    coldCacheWarning,
    wallClockGapRatio,
    wallClockGapNote,
    transactionCount,
    tableAccessMap,
    healthScoreNote,
  };
}
