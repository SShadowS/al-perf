import type { ProcessedNode } from "../../types/processed.js";

export interface SqlPatternGroup {
  table: string;
  totalHits: number;
  totalSelfTime: number;
  patterns: Array<{
    query: string;       // normalized SQL (first 200 chars)
    hitCount: number;
    selfTime: number;
  }>;
}

const SQL_PREFIX_RE = /^(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i;

/**
 * Extract table name from a SQL statement.
 * Handles:
 *  - FROM "Table Name"
 *  - FROM [Table Name]
 *  - FROM dbo."Table Name$guid"
 *  - INSERT INTO "Table Name"
 *  - UPDATE "Table Name"
 *  - MERGE "Table Name"
 */
function extractTableName(sql: string): string | null {
  // For INSERT INTO / MERGE INTO, look after INTO
  // For UPDATE, the table follows directly
  // For SELECT/DELETE, look for FROM
  let match: RegExpMatchArray | null;

  if (/^INSERT\b/i.test(sql)) {
    match = sql.match(/\bINTO\s+(?:dbo\.)?(?:"([^"]+)"|(\[([^\]]+)\])|(\S+))/i);
  } else if (/^UPDATE\b/i.test(sql)) {
    match = sql.match(/^UPDATE\s+(?:dbo\.)?(?:"([^"]+)"|(\[([^\]]+)\])|(\S+))/i);
  } else if (/^MERGE\b/i.test(sql)) {
    match = sql.match(/\bMERGE\s+(?:INTO\s+)?(?:dbo\.)?(?:"([^"]+)"|(\[([^\]]+)\])|(\S+))/i);
  } else {
    // SELECT or DELETE — look for FROM
    match = sql.match(/\bFROM\s+(?:dbo\.)?(?:"([^"]+)"|(\[([^\]]+)\])|(\S+))/i);
  }

  if (!match) return null;

  // Extract the raw table name from whichever capture group matched
  const raw = match[1] || match[3] || match[4];
  if (!raw) return null;

  // Strip GUID suffix after $
  const dollarIdx = raw.indexOf("$");
  return dollarIdx >= 0 ? raw.substring(0, dollarIdx) : raw;
}

function isSqlNode(node: ProcessedNode): boolean {
  return SQL_PREFIX_RE.test(node.callFrame.functionName);
}

export function extractSqlPatterns(nodes: ProcessedNode[]): SqlPatternGroup[] {
  const tableMap = new Map<string, {
    totalHits: number;
    totalSelfTime: number;
    patternMap: Map<string, { query: string; hitCount: number; selfTime: number }>;
  }>();

  for (const node of nodes) {
    if (!isSqlNode(node)) continue;

    const fnName = node.callFrame.functionName;
    const table = extractTableName(fnName);
    if (!table) continue;

    const truncatedQuery = fnName.length > 200 ? fnName.substring(0, 200) : fnName;

    let group = tableMap.get(table);
    if (!group) {
      group = { totalHits: 0, totalSelfTime: 0, patternMap: new Map() };
      tableMap.set(table, group);
    }

    group.totalHits += node.hitCount;
    group.totalSelfTime += node.selfTime;

    const existing = group.patternMap.get(truncatedQuery);
    if (existing) {
      existing.hitCount += node.hitCount;
      existing.selfTime += node.selfTime;
    } else {
      group.patternMap.set(truncatedQuery, {
        query: truncatedQuery,
        hitCount: node.hitCount,
        selfTime: node.selfTime,
      });
    }
  }

  const result: SqlPatternGroup[] = [];
  for (const [table, group] of tableMap) {
    result.push({
      table,
      totalHits: group.totalHits,
      totalSelfTime: group.totalSelfTime,
      patterns: Array.from(group.patternMap.values()).sort((a, b) => b.hitCount - a.hitCount),
    });
  }

  result.sort((a, b) => b.totalHits - a.totalHits);
  return result.slice(0, 15);
}
