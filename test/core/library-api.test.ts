import { describe, expect, test } from "bun:test";
import type {
	DetectedPattern,
	SqlActivityCorroboration,
	SqlEvidence,
	SqlStatementEvidence,
} from "../../src/index.js";
import { bySqlRankDesc } from "../../src/index.js";

/**
 * Public library API surface (src/index.ts) — SQL evidence layer additions.
 *
 * `bySqlRankDesc` and the SQL evidence types are consumed by both the CLI
 * (--sort sql) and MCP (sort:"sql") surfaces; this test pins that a library
 * consumer can reach them through the single `al-perf` entrypoint instead of
 * reaching into src/semantic/sql-evidence.js or src/types/patterns.js
 * directly. The type-only imports above are the authoritative check for the
 * type re-exports: if SqlEvidence/SqlStatementEvidence/SqlActivityCorroboration
 * stopped being exported from src/index.ts, `bunx tsc --noEmit` fails to
 * compile src/index.ts's own export statements (bun:test itself erases
 * type-only imports at runtime, so it can't catch a missing type export on
 * its own).
 */
describe("library API surface (src/index.ts)", () => {
	test("bySqlRankDesc is exported and usable as a comparator", () => {
		expect(typeof bySqlRankDesc).toBe("function");

		const makePattern = (id: string, sqlRank?: number): DetectedPattern => ({
			id,
			severity: "warning",
			title: id,
			description: "",
			impact: 0,
			involvedMethods: [],
			evidence: "",
			sqlRank,
		});
		const sorted = [makePattern("a", 10), makePattern("b", 20)].sort(
			bySqlRankDesc,
		);
		expect(sorted.map((p) => p.id)).toEqual(["b", "a"]);
	});

	test("SQL evidence types are constructible via the library entrypoint", () => {
		const statement: SqlStatementEvidence = {
			text: "SELECT ?",
			operation: "SELECT",
			table: null,
			extensionAppId: null,
			readUncommitted: false,
			sampledHitCount: 1,
			sampledCostUs: 1,
			attribution: "object-method",
		};
		const evidence: SqlEvidence = {
			statements: [statement],
			totalSampledCostUs: 1,
			totalSampledHitCount: 1,
			provenance: "sampled-estimate",
			attribution: "object-method",
		};
		const activity: SqlActivityCorroboration = {
			measuredSqlCount: 0,
			measuredSqlDurationMs: 0,
			sampledAttributedCostUs: 0,
		};
		expect(evidence.statements).toEqual([statement]);
		expect(activity.measuredSqlCount).toBe(0);
	});
});
