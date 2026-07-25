/**
 * telemetry-sql.ts — pure logic for the telemetry SQL evidence layer: AL stack
 * parsing, the routine join key, statement redaction, and the statement→signal
 * join. No I/O and no KQL; `appinsights.ts` calls into this module so SQL-shape
 * knowledge stays out of the adapter and every rule here is unit-testable
 * without a fetch mock.
 */

import {
	classifySqlOperation,
	parseSqlTable,
	type SqlOperation,
} from "../core/sql-node.js";
import {
	canonicalObjectType,
	normalizeAppGuid,
	normalizeTriggerName,
} from "../semantic/identity.js";

/**
 * The AL frame grammar, verified against real RT0005 rows in Gate 0:
 *   "<Object Name>"(<ObjectType> <ObjectId>).<Method> line <N> - <app info>
 * Header lines (`AppObjectType:`, `AppObjectId:`) precede `AL CallStack:` and
 * are NOT frames — taking line 0 (the pre-fix behavior) yields a header string,
 * never a method. The marker `AL CallStack:` must be found first to avoid
 * matching fake frames that appear before it in the input.
 */
const AL_FRAME_RE = /"[^"]*"\([A-Za-z]+\s+\d+\)\.([A-Za-z_][\w]*)/;

export function parseAlStackFrame(stack: string): string | null {
	if (!stack) return null;

	// Find the AL CallStack marker first; skip any fake frames that precede it
	const idx = stack.indexOf("AL CallStack:");
	if (idx === -1) return null;

	// Search for the frame pattern starting from the marker
	const frameText = stack.slice(idx);
	const match = AL_FRAME_RE.exec(frameText);
	return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// telemetryRoutineKey
// ---------------------------------------------------------------------------

/**
 * The join key evidence attaches on. Uses the SAME normalizers as
 * `computeTelemetryFingerprint` (fingerprint.ts) so the key and the identity
 * can never disagree on casing or trigger spelling.
 *
 * `signalId` is DELIBERATELY omitted: finding identity includes it, so a key
 * that carried it could only ever reach RT0005 findings — and the whole point
 * is that RT0005 statements must also annotate the RT0018 finding for the same
 * routine.
 *
 * The separator is the ASCII unit separator (`\u001f`), the same as fingerprint.ts:237,
 * to prevent field-boundary collisions (see test regression for pipe-collision).
 */
export function telemetryRoutineKey(
	appId: string,
	objectType: string,
	objectId: number,
	methodName: string,
): string {
	return [
		normalizeAppGuid(appId),
		canonicalObjectType(objectType),
		String(objectId),
		normalizeTriggerName(methodName).toLowerCase(),
	].join("\u001f");
}

// ---------------------------------------------------------------------------
// redactSqlForSink
// ---------------------------------------------------------------------------

export interface RedactedStatement {
	text: string;
	operation: SqlOperation;
	table: string | null;
	extensionAppId: string | null;
	columnCount: number | null;
	truncated: boolean;
}

const MAX_NAMED_COLUMNS = 5;

/** Mirrors parseSqlTable's GUID check (src/core/sql-node.ts) — not exported there. */
const GUID_RE =
	/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

type Token =
	| { kind: "ident"; value: string; quote: '"' | "[" }
	| { kind: "literal" }
	| { kind: "other"; value: string };

interface TokenizeResult {
	tokens: Token[];
	/**
	 * True when scanning stopped early at an unterminated string literal or
	 * block comment that runs to end-of-input — the hallmark of the platform
	 * truncating raw SQL text at its length cap, never a mid-statement edit.
	 */
	truncated: boolean;
	/** Index into the source string up to which `tokens` was built — equals `sql.length` when not truncated. */
	consumed: number;
}

/**
 * Scanner, not a regex sweep: rule 1 of the spec's §6 requires stripping the
 * company/database prefix from EVERY table reference, and identifiers can
 * contain `$`, spaces, dots and escaped quotes.
 *
 * Two different failure modes, two different outcomes:
 *  - An unterminated quoted identifier or bracket is genuinely unparseable
 *    (or the truncation cut lands inside a name we can't safely partially
 *    redact) — fails CLOSED, `null`, the whole statement is dropped.
 *  - An unterminated string literal or block comment can ONLY happen by
 *    running off the end of the input (indexOf has nowhere else to find the
 *    close), which is exactly what an 8,192-char length-capped capture does.
 *    Everything scanned before that point is complete and safe, so scanning
 *    stops there and the caller is told where — no need to pre-guess this by
 *    counting quote characters (which a stray apostrophe inside a block or
 *    line comment would miscount).
 */
function tokenize(sql: string): TokenizeResult | null {
	const tokens: Token[] = [];
	let i = 0;
	while (i < sql.length) {
		const c = sql[i];
		if (c === '"') {
			const end = sql.indexOf('"', i + 1);
			if (end === -1) return null; // unterminated identifier
			tokens.push({ kind: "ident", value: sql.slice(i + 1, end), quote: '"' });
			i = end + 1;
		} else if (c === "[") {
			let j = i + 1;
			let value = "";
			for (;;) {
				const close = sql.indexOf("]", j);
				if (close === -1) return null; // unterminated bracket identifier
				if (sql[close + 1] === "]") {
					value += `${sql.slice(j, close)}]`;
					j = close + 2;
					continue;
				}
				value += sql.slice(j, close);
				j = close + 1;
				break;
			}
			tokens.push({ kind: "ident", value, quote: "[" });
			i = j;
		} else if (c === "'" || (c === "N" && sql[i + 1] === "'")) {
			const literalStart = i;
			let j = c === "N" ? i + 2 : i + 1;
			let terminated = false;
			for (;;) {
				const close = sql.indexOf("'", j);
				if (close === -1) break; // runs off the end -> truncation boundary
				if (sql[close + 1] === "'") {
					j = close + 2;
					continue;
				}
				j = close + 1;
				terminated = true;
				break;
			}
			if (!terminated) {
				return { tokens, truncated: true, consumed: literalStart };
			}
			tokens.push({ kind: "literal" });
			i = j;
		} else if (c === "/" && sql[i + 1] === "*") {
			const commentStart = i;
			const end = sql.indexOf("*/", i + 2);
			if (end === -1)
				return { tokens, truncated: true, consumed: commentStart };
			i = end + 2;
		} else if (c === "-" && sql[i + 1] === "-") {
			const end = sql.indexOf("\n", i);
			i = end === -1 ? sql.length : end + 1;
		} else {
			tokens.push({ kind: "other", value: c });
			i++;
		}
	}
	return { tokens, truncated: false, consumed: sql.length };
}

/**
 * True when the ident at `tokens[i]` is a raw database name in a 3-part
 * `"DB".dbo."Table"` reference — recognized by peeking past the `.dbo.`
 * joiner for a following identifier. Database names carry no `$`, so
 * `logicalIdentifier` alone would pass one through unredacted (it has
 * nothing to split on); this closes that gap. Mirrors the 3-part shape
 * parseSqlTable already resolves (src/core/sql-node.ts) — `dbo` is the only
 * bare schema this recognizes, same as there.
 */
function isDatabaseQualifier(tokens: Token[], i: number): boolean {
	let j = i + 1;
	let joiner = "";
	for (; j < tokens.length; j++) {
		const tok = tokens[j];
		if (tok.kind !== "other") break;
		joiner += tok.value;
	}
	const next = tokens[j];
	return next?.kind === "ident" && /^\s*\.\s*dbo\s*\.\s*$/i.test(joiner);
}

/**
 * `Company$Table`, `Company$Table$guid`, `Table$guid` -> the logical table
 * name, discarding the company and any extension GUID. Mirrors
 * parseSqlTable's segment rules so a 2-part `Table$guid`
 * (DataPerCompany=false) resolves to the TABLE, not the GUID — a plain
 * `parts[1]` guess here would print the GUID as if it were the table name.
 * Returns null for a `$`-bearing identifier that matches none of BC's
 * documented physical name shapes: the caller drops the whole statement
 * rather than emit an unclassified segment that might be a company name
 * (fail closed).
 */
function logicalIdentifier(raw: string): string | null {
	const parts = raw.split("$");
	if (parts.length === 1) return parts[0];
	if (parts.length === 2) return GUID_RE.test(parts[1]) ? parts[0] : parts[1];
	if (parts.length === 3) return parts[1];
	return null;
}

/**
 * Redacts a raw SQL statement (BC profile SQL nodes or RT0005 telemetry
 * text) for an external sink — GitHub/Azure DevOps issues. This is the
 * privacy boundary: company names, the database name and literal values
 * must never survive; logical table names and extension GUIDs are schema,
 * not customer data, and are kept. Anything the tokenizer can't fully
 * account for is dropped (`null`) rather than emitted half-redacted.
 */
export function redactSqlForSink(sql: string): RedactedStatement | null {
	const result = tokenize(sql);
	if (!result) return null;
	const { tokens, truncated, consumed } = result;
	const body = truncated ? sql.slice(0, consumed) : sql;

	const operation = classifySqlOperation(body);
	const { table, extensionAppId } = parseSqlTable(body);

	let out = "";
	let columnCount: number | null = null;
	let namedColumns = 0;
	let seenFrom = false;
	for (const [idx, t] of tokens.entries()) {
		if (t.kind === "literal") {
			out += "'?'";
			continue;
		}
		if (t.kind === "ident") {
			if (isDatabaseQualifier(tokens, idx)) continue; // drop the bare database name
			const logical = logicalIdentifier(t.value);
			if (logical === null) return null; // unrecognized shape -> fail closed
			if (!seenFrom) {
				namedColumns++;
				if (namedColumns > MAX_NAMED_COLUMNS) continue;
			}
			out += t.quote === "[" ? `[${logical}]` : `"${logical}"`;
			continue;
		}
		out += t.value;
		if (/\bFROM\b\s*$/i.test(out)) seenFrom = true;
	}

	// A dropped 3-part database identifier leaves a stray "." before "dbo";
	// collapse it back to the 2-part shape.
	out = out.replace(/(^|\s)\.(dbo)\b/gi, "$1$2");

	// Bare numbers and hex literals — the profile-side normalizer misses hex.
	// Must run BEFORE the "+N more" marker below: that marker's own digits
	// would otherwise get blanked right back out by this same pass.
	out = out
		.replace(/\b0x[0-9a-f]+\b/gi, "?")
		.replace(/(?<![@\w])\d+(?:\.\d+)?\b/g, "?");

	if (namedColumns > MAX_NAMED_COLUMNS) {
		columnCount = namedColumns;
		// Dropped column idents still leave their separating commas behind.
		out = out.replace(/,(?:\s*,)+/g, ",");
		out = out.replace(
			/\bFROM\b/i,
			`…+${namedColumns - MAX_NAMED_COLUMNS} more FROM`,
		);
	}

	return {
		text: out.replace(/\s+/g, " ").trim(),
		operation,
		table,
		extensionAppId,
		columnCount,
		truncated,
	};
}
