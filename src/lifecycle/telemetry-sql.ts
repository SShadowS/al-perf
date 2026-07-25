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
/**
 * True when a scanned identifier value shows signs of having swallowed
 * clause text past an unmatched delimiter, rather than being a real
 * identifier: a bare FROM/WHERE/SELECT keyword, a literal newline, or a
 * quote character that could only appear by scanning across a string
 * literal's boundary or into another quoted region (which one depends on
 * the delimiter — a bracket identifier should never legitimately contain
 * EITHER quote char; a double-quoted identifier can legitimately contain an
 * embedded `"` via the `""` escape, so only a stray `'` is foreign to it).
 * An identifier that swallowed clause text is not an identifier — the
 * caller fails the whole statement closed rather than echo it, literal
 * values included.
 */
function sawSwallowedClauseText(value: string, foreignQuotes: RegExp): boolean {
	return (
		foreignQuotes.test(value) ||
		/[\r\n]/.test(value) ||
		/\b(?:FROM|WHERE|SELECT)\b/i.test(value)
	);
}

function tokenize(sql: string): TokenizeResult | null {
	const tokens: Token[] = [];
	let i = 0;
	while (i < sql.length) {
		const c = sql[i];
		if (c === '"') {
			let j = i + 1;
			let value = "";
			for (;;) {
				const close = sql.indexOf('"', j);
				if (close === -1) return null; // unterminated identifier
				if (sql[close + 1] === '"') {
					value += `${sql.slice(j, close)}"`;
					j = close + 2;
					continue;
				}
				value += sql.slice(j, close);
				j = close + 1;
				break;
			}
			if (sawSwallowedClauseText(value, /'/)) return null;
			tokens.push({ kind: "ident", value, quote: '"' });
			i = j;
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
			if (sawSwallowedClauseText(value, /["']/)) return null;
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
 * True when the ident at `tokens[i]` is a leading qualifier segment in a
 * multi-part `"DB"."dbo"."Table"` / `"DB".dbo."Table"` reference — recognized
 * by peeking past the joiner for a following identifier. Database/server
 * names carry no `$`, so `logicalIdentifier` alone would pass one through
 * unredacted (it has nothing to split on); this closes that gap.
 *
 * The joiner between two idents can be a bare dot (when the next segment —
 * e.g. `dbo` — is ITSELF quoted/bracketed and so arrives as its own `ident`
 * token) or a dot-word-dot (when the next segment is a bare, unquoted word
 * such as `dbo` or an arbitrary schema name). Mirrors the QUALIFIER regex in
 * src/core/sql-node.ts, which strips ANY quoted/bracketed segment ahead of
 * the final table name — not just the literal `dbo` spelling — so a
 * server/database ident is dropped regardless of how the segment after it is
 * quoted or spelled.
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
	return (
		next?.kind === "ident" &&
		/^\s*\.\s*(?:[A-Za-z_]\w*\s*\.\s*)?$/.test(joiner)
	);
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
	// Company$Table$guid: parts[1] is the table only when parts[2] really is
	// the extension GUID it claims to be. An unrecognized 3rd segment means
	// this isn't that shape at all — parts[1] could just as easily be a
	// second company-name fragment (e.g. "ACME$HOLDING$Sales Header" has no
	// GUID anywhere in it) — so guessing wrong here would print a company
	// fragment as if it were the table name. Mirrors parseSqlTable's own
	// 3-part rule (src/core/sql-node.ts), which already GUID-checks parts[2].
	if (parts.length === 3) return GUID_RE.test(parts[2]) ? parts[1] : null;
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
	if (operation === "OTHER") return null; // no operation classifies (incl. "") -> fail closed rather than emit a meaningless result
	const { table: rawTable, extensionAppId } = parseSqlTable(body);
	// parseSqlTable deliberately never $-splits a BRACKET-quoted name (brackets
	// mark system-table syntax, which is never company-prefixed there) — but
	// BC also uses bracket syntax for ordinary $-prefixed physical names, so
	// that shortcut lets a company name straight through this field even when
	// `text` (which $-splits every ident, quote style aside) is already
	// clean. Route it through the same rule as every other emitted
	// identifier, and fail the WHOLE statement closed if it still can't be
	// resolved — a table field is not exempt from the tokenizer's own rule.
	const table = rawTable === null ? null : logicalIdentifier(rawTable);
	if (rawTable !== null && table === null) return null; // unrecognized shape -> fail closed

	let out = "";
	let columnCount: number | null = null;
	let namedColumns = 0;
	let seenFrom = false;
	let expectTableRef = false;
	let tableRefLogical: string | null = null;
	for (const [idx, t] of tokens.entries()) {
		if (t.kind === "literal") {
			out += "'?'";
			continue;
		}
		if (t.kind === "ident") {
			if (isDatabaseQualifier(tokens, idx)) continue; // drop the bare database name
			const logical = logicalIdentifier(t.value);
			if (logical === null) return null; // unrecognized shape -> fail closed
			if (expectTableRef && tableRefLogical === null) {
				tableRefLogical = logical; // first non-qualifier ident after FROM/INTO/UPDATE/MERGE
				expectTableRef = false;
			}
			if (!seenFrom) {
				namedColumns++;
				if (namedColumns > MAX_NAMED_COLUMNS) continue;
			}
			// A kept bracket identifier can still carry a literal "]" (from a
			// "]]"-escaped physical name whose logical segment wasn't
			// discarded by the $-split) — re-double it on the way back out, or
			// the emitted "[...]" closes early and the tail reads as raw SQL.
			out +=
				t.quote === "["
					? `[${logical.replace(/\]/g, "]]")}]`
					: `"${logical}"`;
			continue;
		}
		out += t.value;
		if (/\bFROM\b\s*$/i.test(out)) seenFrom = true;
		if (/\b(?:FROM|INTO|UPDATE|MERGE)\b\s*$/i.test(out)) expectTableRef = true;
	}

	// Our own escape-aware scan of the table reference can disagree with
	// parseSqlTable's regex-based capture of the SAME reference — e.g. a ""
	// or ]] escape it doesn't know about truncates its capture mid-identifier,
	// silently keeping a company-name fragment as if it were the whole table
	// (parseSqlTable is out of scope here; its own quote/bracket matching has
	// no escape awareness at all). A disagreement is itself proof
	// parseSqlTable's capture can't be trusted for this statement — fail the
	// whole thing closed rather than emit two different "table names" for the
	// same reference.
	if (tableRefLogical !== null && table !== null && tableRefLogical !== table) {
		return null;
	}

	// A bare (unquoted) identifier is only ever emitted as plain "other"
	// characters above — it never becomes a `kind: "ident"` token, so it never
	// goes through logicalIdentifier. parseSqlTable itself supports this bare
	// form (src/core/sql-node.ts), so a bare $-prefixed physical name (company
	// or company+table[+guid]) would otherwise echo straight through
	// untouched. Scan the reassembled text for any leftover run of
	// non-boundary characters that still carries "$" and fail the whole
	// statement closed rather than emit it.
	if (/[^\s.,()]*\$[^\s.,()]*/.test(out)) return null;

	// A dropped qualifier ident leaves a stray "." (or a run of them, for a
	// chain of several dropped idents) before whatever follows it — a bare
	// schema word like "dbo", or directly the final quoted/bracketed table
	// name. Collapse the run to one dot, then drop that one dot too unless a
	// bare word needs it as a separator before the table name.
	out = out.replace(/\.{2,}/g, ".");
	out = out.replace(
		/(^|\s)\.(?:([A-Za-z_]\w*)\.)?(?=["[])/gi,
		(_m, pre: string, word: string | undefined) =>
			pre + (word ? `${word}.` : ""),
	);

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
