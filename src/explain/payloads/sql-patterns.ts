import { isSqlNode, parseSqlTable } from "../../core/sql-node.js";
import type { ProcessedNode } from "../../types/processed.js";

export interface SqlPatternGroup {
	table: string;
	totalHits: number;
	totalSelfTime: number;
	patterns: Array<{
		query: string; // normalized SQL (first 200 chars)
		hitCount: number;
		selfTime: number;
	}>;
}

export function extractSqlPatterns(nodes: ProcessedNode[]): SqlPatternGroup[] {
	const tableMap = new Map<
		string,
		{
			totalHits: number;
			totalSelfTime: number;
			patternMap: Map<
				string,
				{ query: string; hitCount: number; selfTime: number }
			>;
		}
	>();

	for (const node of nodes) {
		if (!isSqlNode(node)) continue;

		const fnName = node.callFrame.functionName;
		const table = parseSqlTable(fnName).table;
		if (!table) continue;

		const truncatedQuery =
			fnName.length > 200 ? fnName.substring(0, 200) : fnName;

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
			patterns: Array.from(group.patternMap.values()).sort(
				(a, b) => b.hitCount - a.hitCount,
			),
		});
	}

	result.sort((a, b) => b.totalHits - a.totalHits);
	return result.slice(0, 15);
}
