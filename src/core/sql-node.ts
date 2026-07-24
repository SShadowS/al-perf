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
 * Optional leading qualifiers: `dbo.` (case-insensitive), or a 3-part
 * `"DB".dbo.` / `[DB].dbo.` form. BC's RT0005 telemetry emits
 * fully-qualified names; the profile's SQL nodes emit the 2-part form. Both
 * must resolve to the TABLE, never to the database. Only `dbo` is recognized
 * as a bare schema name (not arbitrary identifiers like `public`, which are
 * treated as table names).
 */
const QUALIFIER = `(?:(?:"[^"]+"|\\[[^\\]]+\\]|dbo)\\s*\\.\\s*)*`;

/** Precompiled INSERT statement matcher with QUALIFIER prefix consumed. */
const INSERT_MATCHER = new RegExp(
	`\\bINTO\\s+${QUALIFIER}(?:"([^"]+)"|\\[([^\\]]+)\\]|(\\S+))`,
	"i",
);

/** Precompiled UPDATE statement matcher with QUALIFIER prefix consumed. */
const UPDATE_MATCHER = new RegExp(
	`^UPDATE\\s+${QUALIFIER}(?:"([^"]+)"|\\[([^\\]]+)\\]|(\\S+))`,
	"i",
);

/** Precompiled MERGE statement matcher with QUALIFIER prefix consumed. */
const MERGE_MATCHER = new RegExp(
	`\\bMERGE\\s+(?:INTO\\s+)?${QUALIFIER}(?:"([^"]+)"|\\[([^\\]]+)\\]|(\\S+))`,
	"i",
);

/** Precompiled SELECT/FROM statement matcher with QUALIFIER prefix consumed. */
const FROM_MATCHER = new RegExp(
	`\\bFROM\\s+${QUALIFIER}(?:"([^"]+)"|\\[([^\\]]+)\\]|(\\S+))`,
	"i",
);

/**
 * Parse the target table of a SQL statement into logical parts.
 *
 * BC physical names: `Company$Table`, `Company$Table$AppGuid`, `Table$AppGuid`
 * (DataPerCompany=false), bracket-quoted `[System Table]` (never $-split),
 * or a bare name. Splits on EVERY `$` — the predecessor in sql-patterns.ts
 * split at the FIRST `$` and returned the company name.
 *
 * Unparseable (>3 segments, non-GUID 3rd segment, 128-char truncation
 * artifacts) -> { table: null } — callers decide the fallback: the SQL
 * evidence layer keeps the raw statement text with table null; the --deep
 * payload grouping (extractSqlPatterns) skips the node entirely.
 */
export function parseSqlTable(sql: string): {
	table: string | null;
	extensionAppId: string | null;
} {
	let match: RegExpMatchArray | null;
	if (/^INSERT\b/i.test(sql)) {
		match = sql.match(INSERT_MATCHER);
	} else if (/^UPDATE\b/i.test(sql)) {
		match = sql.match(UPDATE_MATCHER);
	} else if (/^MERGE\b/i.test(sql)) {
		match = sql.match(MERGE_MATCHER);
	} else {
		match = sql.match(FROM_MATCHER);
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
