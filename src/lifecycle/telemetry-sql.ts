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
	SQL_PREFIX_RE,
	type SqlOperation,
} from "../core/sql-node.js";
import {
	canonicalObjectType,
	normalizeAppGuid,
	normalizeTriggerName,
} from "../semantic/identity.js";
import type { TelemetrySqlStatementEvidence } from "../types/patterns.js";
import type { TelemetrySignal } from "../types/telemetry.js";

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

/**
 * BC's telemetry pipeline caps the raw SQL text it emits at this many
 * characters. A cut that happens to land exactly on a token boundary (e.g.
 * right after a closing quote, or right at a keyword) leaves the tokenizer
 * with a perfectly well-formed prefix — `tokenize()` has no unterminated
 * literal/comment to report, so its own `truncated` signal is a false
 * negative (I3). The length itself is independent evidence of truncation:
 * a `SELECT * FROM dbo."Cust" WHERE` sql string is never spontaneously
 * exactly this long by legitimate coincidence at BC's own emission cap.
 */
const PLATFORM_TRUNCATION_LENGTH = 8192;

/**
 * Sentinel spliced into `out` at the LIVE clause boundary (the exact point
 * in the tokenizer loop where the projection ends — "FROM" for SELECT/COUNT,
 * "WHERE" for UPDATE, the column list's closing ")" for INSERT), then
 * resolved after the loop into the real "…+N more " marker or dropped
 * entirely. A control character can't occur in redacted SQL text, so unlike
 * a post-hoc `out.replace(/\bFROM\b/i, ...)` over the FINISHED string, it
 * can never match keyword text that ended up sitting inside an already
 * company-stripped identifier's value (e.g. a column literally named
 * "Copied From").
 */
const COLUMN_MARKER = "\u0000";

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

/** One hop of a qualifier/alias dot-chain — see `nextChainHop`'s doc comment. */
interface ChainHop {
	/** Token index of the ident this hop leads to. */
	nextIdentIndex: number;
	/** Segments this hop contributes toward `chainSegmentsAfter`'s count —
	 * the number of `.` characters in the joiner: 1 for a bare dot, 2 for
	 * `.word.` or an empty schema slot (`..`), 3 for `...` or `..word.`,
	 * and so on for any number of omitted parts T-SQL allows. */
	segments: number;
	/** Token index (EXCLUSIVE) up to which a DROPPED ident's own trailing
	 * joiner should be suppressed by the caller. When the joiner has no bare
	 * word, this is the whole joiner (nothing worth keeping). When it has
	 * one, this stops right before the word starts — the bare schema word
	 * and everything from it onward survives regardless of whether the
	 * ident before it is dropped, since the word was never "owned" by that
	 * ident (Fix Round 4: suppressing the whole joiner here previously ate
	 * a legitimate `dbo`).
	 */
	suppressThrough: number;
}

/**
 * Finds the single hop from the ident at `tokens[i]` to whatever ident (if
 * any) a recognized dot-chain joiner leads to next. Returns `null` if
 * nothing recognizable follows (chain ends at `tokens[i]`).
 *
 * Fix Round 5: generalized from four separately-enumerated joiner shapes
 * (bare dot, dot-word-dot, empty-schema-slot "..", each added in a
 * different round as a leak surfaced) to ONE dot-counting rule, because
 * T-SQL allows omitting ANY number of leading qualifier parts —
 * `server...table` (omit database AND schema) and `server..dbo.table`
 * (omit only database) are both valid and were BOTH still leaking after
 * Round 4's three-case enumeration, the same way `database..table` leaked
 * before Round 4 added ITS case. A joiner matching
 * `/^\s*(?:\.\s*)+(?:[A-Za-z_]\w*\s*(?:\.\s*)+)?$/` — one or more dots,
 * optionally followed by a single bare word and one or more MORE dots — is
 * accepted; `segments` is simply how many `.` characters it contains. This
 * subsumes all four previously-enumerated cases (each is just a specific
 * dot count) without adding a fifth, sixth, ... case for the next omitted-
 * part spelling BC's T-SQL generator happens to emit.
 *
 * Mirrors the QUALIFIER regex in src/core/sql-node.ts, which strips ANY
 * quoted/bracketed segment ahead of the final table name — not just the
 * literal `dbo` spelling.
 *
 * Coupling the caller must preserve: this only ever recognizes a joiner made
 * of dots, whitespace and AT MOST one bare word between idents. The "other"-
 * token loop below suppresses a dropped qualifier's joiner (via
 * `suppressThrough`) BEFORE clause-boundary keyword detection runs on that
 * same character; that ordering is only safe because this grammar can never
 * itself contain FROM/WHERE/SET/VALUES-shaped text for the boundary
 * detector to miss. Widening what this function accepts between segments
 * (e.g. more than one bare word) would need that assumption re-checked.
 */
function nextChainHop(tokens: Token[], i: number): ChainHop | null {
	let j = i + 1;
	const joinerStart = j;
	let joiner = "";
	for (; j < tokens.length; j++) {
		const tok = tokens[j];
		if (tok.kind !== "other") break;
		joiner += tok.value;
	}
	const next = tokens[j];
	if (next?.kind !== "ident") return null;
	const m = /^\s*(?:\.\s*)+(?:([A-Za-z_]\w*)\s*(?:\.\s*)+)?$/.exec(joiner);
	if (!m) return null; // joiner isn't the recognized shape -- chain ends here
	const segments = (joiner.match(/\./g) ?? []).length;
	if (!m[1]) {
		return { nextIdentIndex: j, segments, suppressThrough: j }; // no bare word -- suppress the whole joiner
	}
	// Suppress everything before the bare word: find where it starts within
	// this joiner's own token range and stop there.
	let wordStart = joinerStart;
	for (let k = joinerStart; k < j; k++) {
		if (
			/[A-Za-z_]/.test((tokens[k] as Extract<Token, { kind: "other" }>).value)
		) {
			wordStart = k;
			break;
		}
	}
	return { nextIdentIndex: j, segments, suppressThrough: wordStart };
}

/**
 * Counts how many further dot-separated segments — bare schema words
 * counted individually, plus quoted/bracketed idents — follow the ident at
 * `tokens[i]`, walking the WHOLE chain transitively via `nextChainHop`
 * (repeatedly hopping to the next segment) rather than stopping after one
 * hop.
 *
 * Fix Round 3 (position → shape): a database/server qualifier and a table
 * ALIAS qualifying a column are indistinguishable by joiner shape alone —
 * `"50102"."Store No_"` and `"SQLDATABASE"."dbo"."CRONUS$T"` both start with
 * ident-dot-ident. Round 2 (NB1) told them apart by POSITION (only the
 * table-reference-parsing window, right after FROM/INTO/UPDATE/MERGE, could
 * drop a qualifier) — but that only ever sees the statement's FIRST table
 * reference: a JOIN target, a comma-separated FROM item, a MERGE USING
 * clause, or a qualified column in a projection/WHERE all sit OUTSIDE that
 * window and leaked the database name straight through (Fix Round 3, seven
 * repros). Enumerating every keyword that can precede a table reference
 * (JOIN, USING, APPLY, ...) is a list that will always be one keyword
 * behind BC's own T-SQL generator.
 *
 * Shape alone DOES disambiguate, once the WHOLE chain (not just the next
 * hop) is considered: the caller treats `tokens[i]` as a qualifier to drop
 * only when 2+ segments still lead to the chain's real destination.
 * `"50102"."Store No_"` — "50102" has exactly 1 segment following it (the
 * column) → an alias, kept. `"SQLDATABASE"."dbo"."CRONUS$T"` — "SQLDATABASE"
 * has 2 (`dbo`, `CRONUS$T`) → dropped; "dbo" then has only 1 (`CRONUS$T`) →
 * kept. A 4-part fully-qualified COLUMN reference reduces the same way:
 * `"SQLDATABASE"."dbo"."CRONUS$T"."No_"` drops the first two (each still has
 * 2+ segments ahead) and keeps the last two as `"T"."No_"` — the "last two
 * of any chain, however long, are the alias.column/table.column shape kept
 * intact" behavior falls out of this rule automatically, without any
 * special-casing for table-reference vs. projection/WHERE position.
 */
function chainSegmentsAfter(tokens: Token[], i: number): number {
	let count = 0;
	let cursor = i;
	for (;;) {
		const hop = nextChainHop(tokens, cursor);
		if (!hop) return count;
		count += hop.segments;
		cursor = hop.nextIdentIndex;
	}
}

/** True when `tokens[i]` is a letter/underscore "other" char that starts a
 * NEW bare-word run — i.e. the char right before it (if any) isn't itself
 * part of a word. Used only to gate `bareAliasHop` so it scans a given run
 * once, from its start, rather than redundantly re-testing every character
 * inside it. */
function isWordStart(tokens: Token[], i: number): boolean {
	const tok = tokens[i];
	if (tok.kind !== "other" || !/[A-Za-z_]/.test(tok.value)) return false;
	if (i === 0) return true;
	const prev = tokens[i - 1];
	return !(prev.kind === "other" && /[A-Za-z0-9_]/.test(prev.value));
}

/**
 * Fix Round 4 (minor): a BARE (unquoted) table alias immediately qualifying
 * a column, e.g. the `a` in `a."c1"`, is never an `ident` token at all — it
 * has no delimiter, so it's just raw "other" characters, invisible to
 * `chainSegmentsAfter`/`nextChainHop` (which only ever start a walk FROM an
 * ident). Round 2's alias.column pair-counting (`expectingPairedColumn`)
 * only covers a QUOTED alias-prefix for exactly this reason: it has nothing
 * to key off of for a bare one. Left unfixed, a bare alias whose column gets
 * dropped past MAX_NAMED_COLUMNS leaves the alias itself dangling with
 * nothing after it (`a."c5",a. …+1 more FROM …`) — the SAME class of bug
 * Round 2 fixed for quoted aliases, just on the other spelling (this is the
 * brief's own test-3 shape).
 *
 * Detects whether the "other"-token run starting at `tokens[i]` (which MUST
 * be a word-start, see `isWordStart`) is EXACTLY a bare word followed by a
 * single dot, leading directly to an ident — i.e. a bare-alias qualifier —
 * and if so returns that ident's token index. The caller doesn't need to
 * suppress anything itself: it just remembers where in the output this run
 * started (`out.length`, right before emitting it) and, if the ident this
 * hop leads to later turns out to be dropped for exceeding
 * MAX_NAMED_COLUMNS, slices the alias text back out retroactively — cheaper
 * than deferring/buffering every "other" token on the chance it turns out
 * to matter.
 */
function bareAliasHop(
	tokens: Token[],
	i: number,
): { identIndex: number } | null {
	if (!isWordStart(tokens, i)) return null;
	let j = i;
	let run = "";
	while (j < tokens.length && tokens[j].kind === "other") {
		run += (tokens[j] as Extract<Token, { kind: "other" }>).value;
		j++;
	}
	const next = tokens[j];
	if (next?.kind !== "ident") return null;
	return /^[A-Za-z_]\w*\s*\.\s*$/.test(run) ? { identIndex: j } : null;
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
 *
 * **Invariant this function relies on (final review, F10) — read before
 * changing anything below:** customer identity only ever appears inside a
 * `$`-bearing identifier (`Company$Table[$guid]`, stripped by
 * `logicalIdentifier`) or a string literal (blanked). Every code path here
 * assumes that. **Known residual:** a quoted identifier that IS customer
 * data but carries no `$` — e.g. a table alias `AS "CRONUS Danmark A_S"` —
 * survives verbatim; BC generates aliases as object-id numbers in practice,
 * so this is not load-bearing today, but it IS a hole in the invariant
 * above, not covered by it. If BC ever emits a customer-derived, `$`-free
 * quoted identifier anywhere in RT0005 statement text, this function does
 * not catch it.
 */
export function redactSqlForSink(sql: string): RedactedStatement | null {
	const result = tokenize(sql);
	if (!result) return null;
	const { tokens, truncated: tokenizeTruncated, consumed } = result;
	const body = tokenizeTruncated ? sql.slice(0, consumed) : sql;
	// The tokenizer's own signal only fires on an unterminated literal/comment
	// mid-scan; a cut landing on a token boundary produces a well-formed
	// prefix with nothing for it to report. sql.length hitting the platform's
	// own emission cap is truncation evidence tokenize() can't see on its own.
	const truncated =
		tokenizeTruncated || sql.length >= PLATFORM_TRUNCATION_LENGTH;

	const operation = classifySqlOperation(body);
	// NOT `operation === "OTHER"` (NB2): classifySqlOperation's switch has no
	// dedicated MERGE case, so a MERGE statement classifies as "OTHER" too —
	// gating on that would drop a working, SQL_PREFIX_RE-recognized statement
	// class entirely (sql-node.ts has a dedicated MERGE_MATCHER for its table
	// too). Gate on the SAME prefix check classifySqlOperation itself uses to
	// recognize a statement AT ALL, so only a genuinely unclassifiable input
	// (including empty) fails closed here — a MERGE statement still redacts,
	// just reported as SqlOperation "OTHER" (a real, reachable value again).
	if (!SQL_PREFIX_RE.test(body)) return null;
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
	// The "counting as a named column" window is operation-shaped, not just
	// "before the first FROM": SELECT/COUNT project between SELECT and FROM,
	// UPDATE's assignments sit between SET and WHERE, INSERT's column list
	// sits between the target table and the list's closing ")". DELETE has no
	// column list at all, so it never opens the window — without that, its
	// WHERE-clause identifiers (which follow "FROM", same as SELECT's do, but
	// with no columns ever having been named) would otherwise get swept in
	// and silently dropped past MAX_NAMED_COLUMNS.
	let countingColumns = operation === "SELECT" || operation === "COUNT";
	let updateColumnsOpened = false;
	let columnsBoundaryClosed = false;
	let expectTableRef = false;
	let tableRefLogical: string | null = null;
	// True right after a qualifier-prefix ident (e.g. the alias "50102" in
	// "50102"."Store No_") is processed, until its paired column is
	// consumed — an alias.column pair is ONE logical named column, not two,
	// and MUST survive or drop TOGETHER: if only the alias were kept while
	// its column dropped past MAX_NAMED_COLUMNS (or vice versa), the output
	// would carry a dangling "50102." with nothing meaningful after it.
	// `pairedColumnDropped` (valid only while this is true) carries that
	// joint verdict from the prefix to the ident right after it; the "other"
	// token branch below ALSO suppresses the joiner "." between them when a
	// pair is being dropped, or that lone dot survives as its own stray
	// artifact even though both idents either side of it are gone.
	let expectingPairedColumn = false;
	let pairedColumnDropped = false;
	// Fix Round 4: token index (EXCLUSIVE) up to which "other" tokens should
	// be suppressed, set whenever an ident is dropped as a qualifier — its
	// own trailing joiner (see nextChainHop's `suppressThrough`) must vanish
	// alongside it. A prior version of this fix patched the FINISHED string
	// instead (a post-hoc regex guessing at which stray dots were qualifier
	// residue); once Round 3 started keeping intermediate chain segments,
	// that regex could no longer tell "residue from a drop" apart from "a
	// real separator between two KEPT idents that happens to have
	// whitespace before it" and started eating real separators too.
	// Suppressing the dropped ident's OWN joiner here, precisely, removes
	// the ambiguity at the source — nothing is ever left over to guess about.
	let suppressOtherUntilIdx = -1;
	// Fix Round 4 (minor): out.length right before a candidate BARE alias
	// run (see bareAliasHop) started being emitted, valid until the ident it
	// leads to is resolved — used to retroactively remove that run if the
	// ident it qualifies turns out to be dropped past MAX_NAMED_COLUMNS (a
	// bare alias, unlike a quoted one, is invisible to the ident-based pair
	// tracking above, so it can't be held back the same way; rolling it back
	// after the fact is cheaper than deferring every "other" token).
	let bareAliasRollback: number | null = null;
	// [start, end) spans of `out` occupied by a KEPT identifier's own emitted
	// text (quotes/brackets included) — the numeric-blanking pass below must
	// never touch a digit inside one of these, or an ordinary retained column
	// name like "Shortcut Dimension 1 Code" comes out "Shortcut Dimension ?
	// Code". Only recorded for idents that actually get appended to `out`
	// (columns dropped past MAX_NAMED_COLUMNS never reach the `out +=` below).
	const identRanges: Array<[number, number]> = [];
	for (const [idx, t] of tokens.entries()) {
		if (t.kind === "literal") {
			out += "'?'";
			continue;
		}
		if (t.kind === "ident") {
			// Consume any bare-alias rollback point set by the "other"-token
			// branch below, immediately — captured fresh per ident so it can
			// never leak into some LATER, unrelated ident that just happens
			// not to overflow.
			const myBareAliasRollback = bareAliasRollback;
			bareAliasRollback = null;
			// Resolve any pending pair verdict from the PREVIOUS ident first,
			// unconditionally — structurally, the ident right after an
			// alias-prefix's joiner IS its paired column
			// (chainSegmentsAfter's own lookahead guarantees this).
			// `isPairedColumnHalf` marks this ident as already accounted for
			// by its prefix, so the counting block further down must skip
			// it — otherwise a KEPT pair's second half would increment
			// namedColumns all over again.
			let isPairedColumnHalf = false;
			if (expectingPairedColumn) {
				expectingPairedColumn = false;
				isPairedColumnHalf = true;
				if (pairedColumnDropped) continue; // drop the column half of a pair whose alias prefix didn't survive MAX_NAMED_COLUMNS
			}
			// Fix Round 3 (NB1's own follow-up): 2+ further segments in the
			// SAME dot-chain means this ident is a stripped-away qualifier
			// (database/server name), no matter WHERE in the statement it
			// sits — a JOIN target, a comma-separated FROM item, a MERGE
			// USING clause, a fully-qualified column. Exactly 1 further
			// segment means this ident is the FIRST half of an alias.column
			// pair, kept (with its pair) below. See chainSegmentsAfter's own
			// doc comment for the full reasoning and the boundary-detection
			// coupling this grammar must preserve.
			const followingSegments = chainSegmentsAfter(tokens, idx);
			if (followingSegments >= 2) {
				// This ident's own hop determines exactly how much of ITS
				// trailing joiner to suppress (stopping short of a bare
				// schema word, which survives regardless — see
				// nextChainHop's doc comment). followingSegments >= 2
				// guarantees a hop exists here.
				const hop = nextChainHop(tokens, idx);
				if (hop) suppressOtherUntilIdx = hop.suppressThrough;
				continue; // drop the qualifier segment
			}
			const logical = logicalIdentifier(t.value);
			if (logical === null) return null; // unrecognized shape -> fail closed
			// The table reference must resolve to the chain's FINAL segment
			// (followingSegments === 0), not merely "the first ident this
			// loop didn't drop" — a 3+ part chain like
			// "SQLDATABASE"."dbo"."CRONUS$T" now KEEPS "dbo" too
			// (followingSegments === 1, same alias.column shape as any
			// other pair), but "dbo" is an intermediate segment, not the
			// table. Capturing it as tableRefLogical would compare it
			// against parseSqlTable's own "T" and fail the C5 cross-check
			// on a false disagreement.
			const isTableRefIdent =
				expectTableRef && tableRefLogical === null && followingSegments === 0;
			if (isTableRefIdent) {
				tableRefLogical = logical; // final segment of the table-reference chain after FROM/INTO/UPDATE/MERGE
				expectTableRef = false;
				// INSERT's column list starts immediately after the target
				// table, with no keyword of its own to open the window on.
				if (operation === "INSERT") countingColumns = true;
			}
			// The target table itself is never a "named column", regardless
			// of the window above — for INSERT it would otherwise be counted
			// as column #1 by the line above having just opened the window.
			// A paired column's SECOND half is skipped too — it was already
			// counted (once) via its prefix, right above.
			if (countingColumns && !isTableRefIdent && !isPairedColumnHalf) {
				namedColumns++;
				const overLimit = namedColumns > MAX_NAMED_COLUMNS;
				if (followingSegments === 1) {
					// This ident is only a PREFIX (its paired column, right
					// after the joiner, is what the count is really about) —
					// carry the same verdict forward so both halves survive
					// or drop together (handled at the top of this block on
					// the next ident).
					expectingPairedColumn = true;
					pairedColumnDropped = overLimit;
				}
				if (overLimit) {
					// A BARE alias immediately qualifying this (now-dropped)
					// column is invisible to the pair-tracking above (see
					// bareAliasHop's doc comment) — roll it back too, or it's
					// left dangling with nothing after it.
					if (myBareAliasRollback !== null)
						out = out.slice(0, myBareAliasRollback);
					continue;
				}
			}
			// A kept identifier can still carry a literal delimiter char (from
			// a "]]"/`""`-escaped physical name whose logical segment wasn't
			// discarded by the $-split) — re-double it on the way back out, or
			// the emitted identifier closes early and the tail reads as raw
			// SQL. Symmetric fix for both delimiters: the tokenizer already
			// UN-escapes "" -> " while scanning (see tokenize()'s `"` branch),
			// so `logical` can legitimately carry a bare `"` the same way a
			// bracket identifier can carry a bare `]`.
			const identStart = out.length;
			out +=
				t.quote === "["
					? `[${logical.replace(/\]/g, "]]")}]`
					: `"${logical.replace(/"/g, '""')}"`;
			identRanges.push([identStart, out.length]);
			continue;
		}
		// The joiner between a dropped alias prefix and its (about-to-be-
		// dropped) paired column is its OWN "other" token (typically a bare
		// "."), never part of either ident's value — suppress it too, or a
		// lone "." survives with nothing meaningful on either side of it.
		if (expectingPairedColumn && pairedColumnDropped) continue;
		// A dropped QUALIFIER's own trailing joiner (Fix Round 4) — see
		// suppressOtherUntilIdx's doc comment above.
		if (idx < suppressOtherUntilIdx) continue;
		// Mark a candidate BARE alias run (Fix Round 4, minor) so the ident
		// it leads to can roll it back if that ident is dropped past
		// MAX_NAMED_COLUMNS — see bareAliasHop's doc comment. The run's own
		// characters still get appended normally below either way; this
		// only records WHERE they started.
		if (bareAliasHop(tokens, idx)) bareAliasRollback = out.length;
		out += t.value;
		if (
			operation === "UPDATE" &&
			!updateColumnsOpened &&
			/\bSET\b\s*$/i.test(out)
		) {
			countingColumns = true;
			updateColumnsOpened = true;
		} else if (countingColumns && !columnsBoundaryClosed) {
			// Splice the sentinel live, at the boundary token itself — see
			// COLUMN_MARKER's doc comment for why this can't be a post-hoc
			// regex over the finished string.
			if (
				(operation === "SELECT" || operation === "COUNT") &&
				/\bFROM\b\s*$/i.test(out)
			) {
				out = `${out.slice(0, -"FROM".length)}${COLUMN_MARKER}${out.slice(-"FROM".length)}`;
				countingColumns = false;
				columnsBoundaryClosed = true;
			} else if (operation === "UPDATE" && /\bWHERE\b\s*$/i.test(out)) {
				out = `${out.slice(0, -"WHERE".length)}${COLUMN_MARKER}${out.slice(-"WHERE".length)}`;
				countingColumns = false;
				columnsBoundaryClosed = true;
			} else if (operation === "INSERT" && t.value === ")") {
				out = `${out.slice(0, -1)}${COLUMN_MARKER})`;
				countingColumns = false;
				columnsBoundaryClosed = true;
			}
		}
		if (/\b(?:FROM|INTO|UPDATE|MERGE)\b\s*$/i.test(out)) expectTableRef = true;
	}

	// Bare numbers and hex literals — the profile-side normalizer misses hex.
	// Runs on the reassembled string, so a match's index must be checked
	// against identRanges: this is a text-level regex sweep, not aware on its
	// own that some of that text is a KEPT identifier's value rather than raw
	// SQL punctuation/keywords (see identRanges' own doc comment above). One
	// combined pass (not two chained `.replace()` calls) so every match's
	// offset is measured against the SAME unshortened string identRanges was
	// recorded against — a second pass over the first pass's (shorter)
	// result would see shifted offsets and check the wrong ranges. The hex
	// alternative is listed first so it wins at a shared start position (a
	// leading "0" in "0xDEAD" can't match the bare-digit alternative anyway:
	// its trailing `\b` fails between the digit and the following "x").
	// Must run before any later pass changes `out`'s length (dot cleanup,
	// comma collapse, the "+N more" marker) or these recorded positions go
	// stale.
	const isInsideIdent = (at: number) =>
		identRanges.some(([start, end]) => at >= start && at < end);
	out = out.replace(
		/\b0x[0-9a-f]+\b|(?<![@\w])\d+(?:\.\d+)?\b/gi,
		(m, at: number) => (isInsideIdent(at) ? m : "?"),
	);

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

	// Same blind spot, other spelling: a bare qualifier carrying NO "$" at all
	// slips past the scan above and echoes verbatim. `dbo."T"` is the ordinary
	// schema form and must survive, but a SECOND bare segment in front of it
	// (`mydb.dbo."T"`, `srv.mydb.dbo."T"`) is a database or linked-server name
	// -- customer identity by any other name. In FIRST table position the
	// parseSqlTable cross-check already sinks these; nothing looks at a join's
	// or a subquery's reference, so fail the whole statement closed here.
	if (/\b[A-Za-z_]\w*\s*\.\s*[A-Za-z_]\w*\s*\.\s*["[]/.test(out)) return null;

	// Fix Round 4: a dropped qualifier's own trailing joiner is now suppressed
	// PRECISELY, inside the loop above (suppressOtherUntilIdx / nextChainHop's
	// suppressThrough), stopping short of any bare schema word it leads to.
	// Earlier rounds patched this with a post-hoc regex here instead
	// (collapse runs of 2+ dots, then strip a whitespace/comma/paren-preceded
	// dot ahead of a quote/bracket) — but once Round 3 started KEEPING
	// intermediate chain segments (e.g. "dbo" in a 3-part reference), that
	// regex could no longer tell "residue from a drop" apart from "a
	// legitimate separator between two KEPT idents that happens to have
	// whitespace before it" (e.g. a newline- or space-formatted qualifier
	// chain) — and silently ate the real separator too. Suppressing the
	// dropped ident's OWN joiner at the source removes the ambiguity
	// entirely: nothing is ever left over here for a regex to guess about.

	if (namedColumns > MAX_NAMED_COLUMNS) {
		columnCount = namedColumns;
		// Dropped column idents still leave their separating commas behind.
		out = out.replace(/,(?:\s*,)+/g, ",");
		const marker = `…+${namedColumns - MAX_NAMED_COLUMNS} more `;
		// The sentinel was spliced in live, at the real clause boundary, by
		// the tokenizer loop above. If the clause never closed (e.g. an
		// UPDATE with no WHERE, or a truncated statement cut off mid column
		// list) no sentinel was inserted — fall back to the tail.
		out = out.includes(COLUMN_MARKER)
			? out.replace(COLUMN_MARKER, marker)
			: `${out} ${marker}`;
	} else if (out.includes(COLUMN_MARKER)) {
		out = out.replace(COLUMN_MARKER, "");
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

// ---------------------------------------------------------------------------
// attachEvidenceToSignals — the statement -> signal join (telemetry-sql-
// evidence plan, Task 9). appinsights.ts owns the KQL and the HTTP fetch for
// the statement-level RT0005 query; this module owns everything downstream
// of the raw rows, same split as parseAlStackFrame/telemetryRoutineKey/
// redactSqlForSink above.
// ---------------------------------------------------------------------------

/** One row from the statement-level RT0005 query, already row-shaped by appinsights.ts's normalizer. */
export interface StatementRow {
	appId: string;
	objectType: string;
	objectId: number;
	stackTrace: string;
	sqlStatement: string;
	occurrences: number;
	measuredTotalMs: number;
	thresholdMs?: number;
	/**
	 * Fix Round 1: the aggregate SIGNAL query groups BY clientType, so a
	 * routine with several clientType constituents (Background, WebClient, …)
	 * mints one TelemetrySignal per constituent. Without this dimension, every
	 * constituent would match the SAME statement rows and a later summing
	 * merge (Task 10) would double- (or N-)count occurrences/measuredTotalMs.
	 * `undefined` — never `""` — when the column is absent/empty, matching
	 * TelemetrySignal.clientType's own convention.
	 */
	clientType?: string;
}

/** Routine key + clientType, joined so a Map key never collides across BOTH dimensions at once (same separator convention as telemetryRoutineKey itself). */
function evidenceKey(
	routineKey: string,
	clientType: string | undefined,
): string {
	return `${routineKey}\u001f${clientType ?? ""}`;
}

/**
 * Attach redacted statements to every signal sharing the routine key — RT0018
 * and RT0005 alike, since `telemetryRoutineKey` omits signalId by design
 * (§4.1: a key that carried it could only ever reach an RT0005 finding, and
 * the whole point is that RT0005's own statements should also annotate the
 * RT0018 finding for the same routine). Also scoped by clientType (Fix Round
 * 1) — see `evidenceKey`'s doc comment and `StatementRow.clientType`'s.
 *
 * Call this ONCE PER SPLIT GROUP, never over a fleet-wide row set — appinsights.ts's
 * pullTelemetrySplit groups both signals and statement rows by
 * (aadTenantId, environmentName) before calling in here per group. A global
 * join keyed on the routine alone would attach one tenant's redacted SQL onto
 * another tenant's finding whose app/object/method happen to match, and that
 * string would reach that tenant's issue tracker.
 *
 * Mutates `signals` in place (sets `.sqlEvidence`) rather than returning a
 * new array — the caller (appinsights.ts) already holds the exact array
 * reference that ends up as `TelemetryBatchDocument.signals`, so mutating it
 * here is what makes evidence visible on the batch without appinsights.ts
 * having to thread a rebuilt array back through. Every signal gets its OWN
 * copies of the statement/threshold objects (Fix Round 1, minor) — two
 * signals sharing a key would otherwise share object references, so a later
 * mutation of one signal's evidence (e.g. a renderer) could silently leak
 * into the other's.
 *
 * Returns the number of statement ROWS that built a valid (routine,
 * clientType) key but matched no signal (Fix Round 2). The strict clientType
 * scoping is intentionally correct — SQL measured in one client session
 * should never annotate a different session's finding — but with several
 * distinct clientType values common on both sides (measured live: 5 on both
 * RT0018 and RT0005), a systematic mismatch silently drops ALL evidence for
 * a routine while looking identical to "queried, genuinely no slow SQL".
 * This count is how the caller (appinsights.ts) surfaces that distinction —
 * rows that fail to parse an AL frame or fail redaction are NOT counted here
 * (that's a different failure mode, already skip-counted upstream in
 * appinsights.ts's normalizeStatementTable); this counts only rows that were
 * fully valid and simply had nowhere to attach.
 */
export function attachEvidenceToSignals(
	signals: TelemetrySignal[],
	rows: readonly StatementRow[],
): number {
	const byKey = new Map<string, TelemetrySqlStatementEvidence[]>();
	const thresholds = new Map<string, { minMs: number; maxMs: number }>();

	for (const row of rows) {
		const method = parseAlStackFrame(row.stackTrace);
		if (!method) continue; // no AL frame -> no routine identity to join on
		const redacted = redactSqlForSink(row.sqlStatement);
		if (!redacted) continue; // fail closed — never emit half-redacted text

		const routineKey = telemetryRoutineKey(
			row.appId,
			row.objectType,
			row.objectId,
			method,
		);
		const key = evidenceKey(routineKey, row.clientType);
		const list = byKey.get(key) ?? [];
		list.push({
			text: redacted.text,
			operation: redacted.operation,
			table: redacted.table,
			extensionAppId: redacted.extensionAppId,
			occurrences: row.occurrences,
			measuredTotalMs: row.measuredTotalMs,
			truncated: redacted.truncated,
			// F7 fix (final review): previously discarded here — computed by
			// redactSqlForSink, then dropped on the floor instead of reaching
			// the finding's structured sqlEvidence.
			columnCount: redacted.columnCount,
		});
		byKey.set(key, list);

		if (row.thresholdMs !== undefined) {
			const t = thresholds.get(key);
			thresholds.set(key, {
				minMs: t ? Math.min(t.minMs, row.thresholdMs) : row.thresholdMs,
				maxMs: t ? Math.max(t.maxMs, row.thresholdMs) : row.thresholdMs,
			});
		}
	}

	const claimedKeys = new Set<string>();
	for (const signal of signals) {
		const routineKey = telemetryRoutineKey(
			signal.appId,
			signal.objectType,
			signal.objectId,
			signal.methodName,
		);
		const key = evidenceKey(routineKey, signal.clientType);
		claimedKeys.add(key);
		const statements = byKey.get(key);
		if (!statements || statements.length === 0) continue;
		statements.sort((a, b) => b.measuredTotalMs - a.measuredTotalMs);
		const threshold = thresholds.get(key);
		signal.sqlEvidence = {
			// Per-signal copies — never share statement/threshold objects
			// across signals, even when they resolve to the same key.
			statements: statements.slice(0, 5).map((s) => ({ ...s })),
			totalMeasuredMs: statements.reduce((n, s) => n + s.measuredTotalMs, 0),
			totalOccurrences: statements.reduce((n, s) => n + s.occurrences, 0),
			provenance: "measured-threshold-gated",
			attribution: "telemetry-stack",
			threshold: threshold ? { ...threshold } : undefined,
		};
	}

	let unmatchedRows = 0;
	for (const [key, statements] of byKey) {
		if (!claimedKeys.has(key)) unmatchedRows += statements.length;
	}
	return unmatchedRows;
}
