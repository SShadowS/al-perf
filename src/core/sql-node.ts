import type { ProcessedNode } from "../types/processed.js";

/**
 * Shared SQL-node helpers. A BC sampling profile embeds SQL statements as
 * call-tree nodes whose callFrame.functionName IS the statement text. These
 * helpers are the single source of truth for recognizing and parsing them —
 * consumed by the --deep AI payload (explain/payloads/sql-patterns.ts) and
 * the SQL evidence layer (semantic/sql-evidence.ts).
 */

/** Statement prefixes that mark a functionName as embedded SQL. */
export const SQL_PREFIX_RE = /^(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i;

export function isSqlFunctionName(name: string): boolean {
	return SQL_PREFIX_RE.test(name);
}

export function isSqlNode(node: ProcessedNode): boolean {
	return isSqlFunctionName(node.callFrame.functionName);
}

export type SqlOperation =
	| "SELECT"
	| "COUNT"
	| "INSERT"
	| "UPDATE"
	| "DELETE"
	| "OTHER";

/** SELECT COUNT(...) is its own class (Count/IsEmpty anti-pattern signal). */
export function classifySqlOperation(sql: string): SqlOperation {
	if (/^SELECT\s+COUNT\s*\(/i.test(sql)) return "COUNT";
	const m = SQL_PREFIX_RE.exec(sql);
	switch (m?.[1]?.toUpperCase()) {
		case "SELECT":
			return "SELECT";
		case "INSERT":
			return "INSERT";
		case "UPDATE":
			return "UPDATE";
		case "DELETE":
			return "DELETE";
		default:
			return "OTHER"; // MERGE and anything unrecognized
	}
}

export function hasReadUncommitted(sql: string): boolean {
	return /WITH\s*\(\s*READUNCOMMITTED\s*\)/i.test(sql);
}

/** Aggregate function present (CalcFields-style query signal). */
export function hasAggregate(sql: string): boolean {
	return /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(sql);
}

/**
 * Conservative literal-blanking for query-SHAPE grouping: string literals
 * (with '' escapes) and bare numbers become `?`. `@N` bind parameters are
 * already placeholders and stay untouched. This groups by shape only — on a
 * sampling profile the grouped hit count is a SAMPLED total, never proof a
 * query executed N times.
 */
export function normalizeSqlShape(sql: string): string {
	return sql
		.replace(/'(?:[^']|'')*'/g, "'?'")
		.replace(/(?<![@\w])\d+(?:\.\d+)?\b/g, "?");
}

const GUID_RE =
	/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/**
 * Parse the target table of a SQL statement into logical parts.
 *
 * BC physical names: `Company$Table`, `Company$Table$AppGuid`, `Table$AppGuid`
 * (DataPerCompany=false), bracket-quoted `[System Table]` (never $-split),
 * or a bare name. Splits on EVERY `$` — the predecessor in sql-patterns.ts
 * split at the FIRST `$` and returned the company name.
 *
 * Unparseable (>3 segments, non-GUID 3rd segment, 128-char truncation
 * artifacts) -> { table: null } — callers keep the raw SQL text instead.
 */
export function parseSqlTable(sql: string): {
	table: string | null;
	extensionAppId: string | null;
} {
	let match: RegExpMatchArray | null;
	if (/^INSERT\b/i.test(sql)) {
		match = sql.match(/\bINTO\s+(?:dbo\.)?(?:"([^"]+)"|\[([^\]]+)\]|(\S+))/i);
	} else if (/^UPDATE\b/i.test(sql)) {
		match = sql.match(/^UPDATE\s+(?:dbo\.)?(?:"([^"]+)"|\[([^\]]+)\]|(\S+))/i);
	} else if (/^MERGE\b/i.test(sql)) {
		match = sql.match(
			/\bMERGE\s+(?:INTO\s+)?(?:dbo\.)?(?:"([^"]+)"|\[([^\]]+)\]|(\S+))/i,
		);
	} else {
		match = sql.match(/\bFROM\s+(?:dbo\.)?(?:"([^"]+)"|\[([^\]]+)\]|(\S+))/i);
	}
	if (!match) return { table: null, extensionAppId: null };

	const bracket = match[2];
	if (bracket) return { table: bracket, extensionAppId: null }; // system table — no $ semantics

	const raw = match[1] || match[3];
	if (!raw) return { table: null, extensionAppId: null };

	const parts = raw.split("$");
	if (parts.length === 1) return { table: parts[0], extensionAppId: null };
	if (parts.length === 2) {
		return GUID_RE.test(parts[1])
			? { table: parts[0], extensionAppId: parts[1] } // Table$guid
			: { table: parts[1], extensionAppId: null }; // Company$Table
	}
	if (parts.length === 3 && GUID_RE.test(parts[2])) {
		return { table: parts[1], extensionAppId: parts[2] }; // Company$Table$guid
	}
	return { table: null, extensionAppId: null };
}
