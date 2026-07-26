import { sortPatterns } from "../core/patterns.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern } from "../types/patterns.js";
import type {
	ObjectInfo,
	RecordOpInfo,
	SourceIndex,
	TableFieldInfo,
	VariableInfo,
} from "../types/source-index.js";
import {
	downgradePageImplicitLoop,
	loopEvidencePhrase,
	loopLocationPhrase,
} from "./implicit-loop.js";
import { PARENLESS_RECORD_BUILTINS } from "./indexer.js";
import { matchAllToSource } from "./locator.js";

/**
 * Check if a record operation targets a temporary variable.
 */
export function isTemporaryOp(
	op: RecordOpInfo,
	variables: VariableInfo[],
	owner?: ObjectInfo,
): boolean {
	if (!op.recordVariable) return false;
	// `Rec` has no `var` declaration, so its temp-ness lives on the owning
	// object: `SourceTableTemporary = true` makes the whole record an in-memory
	// buffer. Without this, every Rec op on such a page reads as SQL.
	if (
		owner?.sourceTableTemporary === true &&
		op.recordVariable.toLowerCase() === "rec"
	) {
		return true;
	}
	const variable = variables.find(
		(v) => v.name.toLowerCase() === op.recordVariable!.toLowerCase(),
	);
	return variable?.isTemporary === true;
}

/** The `ObjectInfo` a matched member belongs to, if the index still holds it. */
export function ownerObject(
	member: { objectType: string; objectId: number },
	index: SourceIndex,
): ObjectInfo | undefined {
	return index.objects.get(`${member.objectType}_${member.objectId}`);
}

/**
 * Check if a record operation's receiver resolves to a variable that is
 * definitively NOT a Record -- e.g. `List of [Text]`, `JsonArray`,
 * `HttpClient`. `RECORD_OPS` (indexer.ts) matches method NAMES only
 * (`Insert`, `Delete`, `Get`, `Find`, ...), and every one of those names is
 * also a real method on several non-Record BC types -- without this guard, a
 * `List of [Text]`'s `.Insert()` in a loop reads as a SQL INSERT, and an
 * `HttpClient`'s `.Delete()` double-reports next to the correct
 * `external-call-in-loop` finding on the same line (see
 * `CodeUnit50300.al`'s `HttpMethodsInLoop`).
 *
 * Fails OPEN (returns false -- "could still be a record, don't exclude it")
 * whenever the variable does not resolve in `variables` -- e.g. an
 * object-level global (see `extractVariables`'s KNOWN LIMITATION in
 * indexer.ts), or a Page/Report/XMLport's implicit `Rec`, which has no `var`
 * declaration at all. Both keep exactly today's behavior: an unresolved
 * receiver is still treated as a possible record, same as before this guard
 * existed.
 */
export function isKnownNonRecordOp(
	op: RecordOpInfo,
	variables: VariableInfo[],
): boolean {
	if (!op.recordVariable) return false;
	const variable = variables.find(
		(v) => v.name.toLowerCase() === op.recordVariable!.toLowerCase(),
	);
	if (!variable) return false; // unresolved -- fail open
	return !variable.isRecord;
}

/**
 * Format a method label for use in involvedMethods arrays.
 */
function methodLabel(m: MethodBreakdown): string {
	return `${m.functionName} (${m.objectType} ${m.objectId})`;
}

/**
 * Aggregation CalcFormula types that force a SQL aggregation over every
 * matching related row — expensive, and worth a `critical` rating.
 *
 * `Exist` is deliberately NOT here: it can short-circuit on the first match,
 * which puts it closer to `Lookup`'s cost profile than to `Sum`/`Count`'s.
 */
const AGGREGATION_CALC_TYPES = new Set<TableFieldInfo["calcFormulaType"]>([
	"Sum",
	"Count",
	"Average",
	"Min",
	"Max",
]);

/**
 * Resolve the field(s) actually implicated by a CalcFields/CalcSums call to
 * their indexed FlowField definitions. Both `calcFieldSeverity` and the
 * suggestion's "this table has ..." fact sentence (`calcFieldFactSentence`)
 * read from this single resolution, so they can never disagree with each
 * other — and so that fact sentence can be omitted outright, rather than
 * guessed, whenever nothing is actually known about the field. Asserting a
 * FlowField type the tool has no evidence for is exactly the kind of
 * confident falsehood this detector's suggestion text exists to eliminate.
 *
 * Falls back to the table's full FlowField set when the call's field list is
 * unknown AND the root declaration was indexed — a bare `CalcFields();` with
 * no arguments calculates every FlowField on the record, so the table's full
 * set genuinely is the true answer there, but only if that set is the whole
 * table's. On a fragment it is whatever the extensions happened to declare.
 *
 * Returns `undefined` when nothing can be resolved OR when what could be
 * resolved is not enough to justify a downgrade:
 *   - the record variable isn't a known Record, or has no table name
 *   - its table isn't in the index at all
 *   - two distinct roots declare that table name (`ambiguous`), so the merged
 *     picture describes neither
 *   - a bare `CalcFields()` on a table whose root was never indexed
 *   - a named field list on such a table where some names did not resolve —
 *     the ones that did not may be the expensive ones
 * Callers must not assert anything about the field's type when this is
 * `undefined` — silence is the honest answer, not a confident guess, and
 * `calcFieldSeverity` maps it to the conservative `critical`.
 */
function resolveCalcFields(
	op: RecordOpInfo,
	variables: VariableInfo[],
	index: SourceIndex,
): TableFieldInfo[] | undefined {
	const recordVariable = op.recordVariable;
	if (!recordVariable) return undefined;

	const variable = variables.find(
		(v) => v.name.toLowerCase() === recordVariable.toLowerCase(),
	);
	// NOTE (documented, not fixed — Issue 6): a Page/Report/XMLport's implicit
	// `Rec` inside a per-row trigger has no `var` declaration, so it never
	// appears in `variables` and this always falls through to `undefined`
	// here. Fails safe (over-severe, never under-severe).
	if (!variable?.isRecord || !variable.tableName) return undefined;

	const table = index.tables.get(variable.tableName.toLowerCase());
	// An ambiguous name is two different tables; nothing read from it is about
	// the one in hand.
	if (!table || table.ambiguous) return undefined;

	const calledFields = op.allFieldArguments;
	if (!calledFields || calledFields.length === 0) {
		// Bare CalcFields() means "every FlowField on the table". On a fragment
		// that set is not the runtime set — an extension's lone Lookup would
		// downgrade the finding while an unseen root Sum is what actually runs.
		//
		// MEASURED, so nobody deletes this as dead: across five corpora
		// (15,436 files with the base app in-tree, a 19,141-file partner
		// solution, and three smaller partner apps) this branch is REACHED 6
		// times and has never CHANGED a finding. All 6 hits are on one
		// fragment table that declares no FlowFields at all, so the
		// empty-resolution path below returns undefined anyway; removing both
		// fences left that corpus byte-identical at 835 findings / 730
		// critical / 105 warning. The fence can only ever preserve the
		// conservative critical, so being wrong here costs nothing — and the
		// shape it guards (an app that extends a table AND calculates a
		// FlowField on it in a loop) is rare, not impossible.
		if (!table.rootSeen) return undefined;
		const allFlowFields = table.fields.filter((f) => f.calcFormulaType);
		return allFlowFields.length > 0 ? allFlowFields : undefined;
	}

	const calledLower = new Set(calledFields.map((f) => f.toLowerCase()));
	const resolved = table.fields.filter(
		(f) => f.calcFormulaType && calledLower.has(f.name.toLowerCase()),
	);
	if (resolved.length === 0) return undefined;

	// A partially-resolved list on a fragment cannot justify a downgrade: the
	// arguments that did NOT resolve may be the expensive ones.
	const allResolved = resolved.length === calledFields.length;
	if (!table.rootSeen && !allResolved) return undefined;

	return resolved;
}

/**
 * Determine CalcFields/CalcSums severity from the resolved field(s) actually
 * passed to the call — not from whether the record's table happens to have
 * some unrelated aggregation FlowField elsewhere. `CalcFields(CheapLookupField)`
 * must not be rated critical just because the same table also has a Sum
 * field nobody is calculating here. `critical` stays the conservative
 * default whenever nothing could be resolved (see `resolveCalcFields`).
 */
function calcFieldSeverity(
	resolved: TableFieldInfo[] | undefined,
): "critical" | "warning" {
	if (!resolved) return "critical";
	const hasAggregation = resolved.some((f) =>
		AGGREGATION_CALC_TYPES.has(f.calcFormulaType),
	);
	return hasAggregation ? "critical" : "warning";
}

/**
 * The factual clause of the suggestion, about THE FIELDS THIS CALL
 * CALCULATES — never about the table.
 *
 * It used to say "This table has Lookup FlowFields", which is false whenever
 * the table also has an aggregation FlowField nobody is calculating here.
 * `Merge Base` in the fixtures is exactly that shape (`Base Total` is a Sum,
 * `Ext Lookup` is a Lookup), and the sentence claimed the table had only
 * Lookups. The severity beside it was already field-scoped — this makes the
 * prose agree with it.
 *
 * Must only ever be called with a resolved field list (see
 * `resolveCalcFields`) — never derived from severity alone, which can be a
 * conservative default rather than actual knowledge of the field's type.
 */
function calcFieldFactSentence(resolved: TableFieldInfo[]): string {
	if (resolved.some((f) => AGGREGATION_CALC_TYPES.has(f.calcFormulaType))) {
		return "The field(s) calculated here are aggregation FlowFields (Sum/Count), which force a SQL aggregation per call.";
	}
	if (resolved.every((f) => f.calcFormulaType === "Exist")) {
		return "The field(s) calculated here are Exist FlowFields — cheaper than Sum/Count since SQL can short-circuit on the first matching row, but still one query per iteration.";
	}
	return "The field(s) calculated here are Lookup FlowFields — cheaper than Sum/Count, but still one SQL query per iteration.";
}

/**
 * Build the calcfields-in-loop suggestion text.
 *
 * `CalcFields` and `CalcSums` need different advice: SetAutoCalcFields only
 * affects FlowFields calculated via CalcFields as each record is retrieved —
 * it has no effect whatsoever on CalcSums, which re-sums a FlowField/SIFT
 * field over the record's current filter on demand. Recommending
 * SetAutoCalcFields for a CalcSums in a loop is confident advice that does
 * nothing, the same class of bug the CalcFields branch below exists to avoid.
 *
 * For CalcFields, the SetAutoCalcFields recommendation and the "SetLoadFields
 * does NOT help" disclaimer always apply, regardless of what is known about
 * the field. The "this table has X FlowFields" fact sentence is conditional
 * on `resolved` in both branches — omitted entirely when the field didn't
 * resolve, so the tool never asserts a FlowField type it doesn't actually
 * know (see `resolveCalcFields`).
 */
function calcFieldsSuggestion(
	opType: "CalcFields" | "CalcSums",
	severity: "critical" | "warning",
	resolved: TableFieldInfo[] | undefined,
): string {
	const fact = resolved ? ` ${calcFieldFactSentence(resolved)}` : "";

	if (opType === "CalcSums") {
		return `Move the CalcSums() outside the loop and run it once on the filtered set, or back the sum with a SIFT (SumIndexFields) key so the total is maintained incrementally.${fact}`;
	}

	const action =
		severity === "critical"
			? "Call SetAutoCalcFields() before the loop so the FlowField is calculated as each record is retrieved, or filter on the FlowField instead of calculating it per row."
			: "Call SetAutoCalcFields() before the loop so the FlowField is calculated as each record is retrieved.";
	return `${action}${fact} Note SetLoadFields() does NOT help here — it does not accept FlowFields.`;
}

/**
 * Detect CalcFields/CalcSums inside loops.
 * Severity: critical for aggregation CalcFormulas (Sum/Count/Average), warning for Lookup-only.
 */
export function detectCalcFieldsInLoop(
	methods: MethodBreakdown[],
	index: SourceIndex,
): DetectedPattern[] {
	const patterns: DetectedPattern[] = [];

	for (const method of methods) {
		// ALL candidates, not just the first: triggers are not name-unique
		// within an object (a report with two dataitems has two
		// OnAfterGetRecord members; a table with two field OnValidate triggers
		// has two OnValidate members). matchToSource's `[0]` used to collapse
		// them onto member #1, double-reporting it while member #2..N were
		// never analyzed at all.
		const matches = matchAllToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);

		for (const match of matches) {
			const opsInLoop = match.features.recordOpsInLoops.filter(
				(op) =>
					(op.type === "CalcFields" || op.type === "CalcSums") &&
					!isTemporaryOp(
						op,
						match.features.variables,
						ownerObject(match, index),
					) &&
					!isKnownNonRecordOp(op, match.features.variables),
			);

			for (const op of opsInLoop) {
				// `resolvedFields` feeds BOTH severity and the suggestion's fact
				// sentence, so they can't drift apart — see resolveCalcFields.
				const resolvedFields = resolveCalcFields(
					op,
					match.features.variables,
					index,
				);
				const severity = downgradePageImplicitLoop(
					calcFieldSeverity(resolvedFields),
					op,
				);
				const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
				patterns.push({
					id: "calcfields-in-loop",
					severity,
					title: `${op.type} inside loop in ${method.functionName}`,
					description: `${op.type}()${recVar} ${loopLocationPhrase(op, op.line, match.file)}. Each iteration triggers a separate SQL query, causing N+1 query performance issues.`,
					impact: method.selfTime,
					involvedMethods: [methodLabel(method)],
					evidence: `${op.type}() at line ${op.line}, column ${op.column} — ${loopEvidencePhrase(op)}`,
					// The filter above (`op.type === "CalcFields" || op.type === "CalcSums"`)
					// guarantees op.type is exactly this union here; .filter() doesn't
					// narrow the array element type for TS, hence the cast.
					suggestion: calcFieldsSuggestion(
						op.type as "CalcFields" | "CalcSums",
						severity,
						resolvedFields,
					),
				});
			}
		}
	}

	return patterns;
}

/**
 * Detect Modify() inside loops.
 * Severity: critical.
 */
export function detectModifyInLoop(
	methods: MethodBreakdown[],
	index: SourceIndex,
): DetectedPattern[] {
	const patterns: DetectedPattern[] = [];

	for (const method of methods) {
		// See detectCalcFieldsInLoop for why ALL candidates must be iterated.
		const matches = matchAllToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);

		for (const match of matches) {
			const opsInLoop = match.features.recordOpsInLoops.filter(
				(op) =>
					(op.type === "Modify" || op.type === "ModifyAll") &&
					!isTemporaryOp(
						op,
						match.features.variables,
						ownerObject(match, index),
					) &&
					!isKnownNonRecordOp(op, match.features.variables),
			);

			for (const op of opsInLoop) {
				const severity = downgradePageImplicitLoop("critical", op);
				const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
				patterns.push({
					id: "modify-in-loop",
					severity,
					title: `${op.type} inside loop in ${method.functionName}`,
					description: `${op.type}()${recVar} ${loopLocationPhrase(op, op.line, match.file)}. Each iteration issues a separate SQL UPDATE, which can be very slow for large datasets.`,
					impact: method.selfTime,
					involvedMethods: [methodLabel(method)],
					evidence: `${op.type}() at line ${op.line}, column ${op.column} — ${loopEvidencePhrase(op)}`,
					suggestion:
						"Collect changes and apply them after the loop, or use ModifyAll() if applicable.",
				});
			}
		}
	}

	return patterns;
}

/**
 * Detect Insert() inside loops.
 * Severity: critical.
 *
 * Each Insert() in a loop is a separate SQL INSERT. The fix differs from
 * modify-in-loop's: build a temporary table and insert once after the loop,
 * or use a bulk-insert pattern.
 */
export function detectInsertInLoop(
	methods: MethodBreakdown[],
	index: SourceIndex,
): DetectedPattern[] {
	const patterns: DetectedPattern[] = [];

	for (const method of methods) {
		// See detectCalcFieldsInLoop for why ALL candidates must be iterated.
		const matches = matchAllToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);

		for (const match of matches) {
			const opsInLoop = match.features.recordOpsInLoops.filter(
				(op) =>
					op.type === "Insert" &&
					!isTemporaryOp(
						op,
						match.features.variables,
						ownerObject(match, index),
					) &&
					!isKnownNonRecordOp(op, match.features.variables),
			);

			for (const op of opsInLoop) {
				const severity = downgradePageImplicitLoop("critical", op);
				const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
				patterns.push({
					id: "insert-in-loop",
					severity,
					title: `${op.type} inside loop in ${method.functionName}`,
					description: `${op.type}()${recVar} ${loopLocationPhrase(op, op.line, match.file)}. Each iteration issues a separate SQL INSERT, which can be very slow for large datasets.`,
					impact: method.selfTime,
					involvedMethods: [methodLabel(method)],
					evidence: `${op.type}() at line ${op.line}, column ${op.column} — ${loopEvidencePhrase(op)}`,
					suggestion:
						"Build a temporary table and insert the records once after the loop, or use a bulk-insert pattern — each Insert() in a loop is a separate SQL INSERT.",
				});
			}
		}
	}

	return patterns;
}

/**
 * Detect Delete()/DeleteAll() inside loops.
 * Severity: critical.
 *
 * A DeleteAll() inside a loop is flagged deliberately: DeleteAll() inside a
 * loop is still N statements — the point of DeleteAll() is to replace the
 * loop, not to live in one.
 */
export function detectDeleteInLoop(
	methods: MethodBreakdown[],
	index: SourceIndex,
): DetectedPattern[] {
	const patterns: DetectedPattern[] = [];

	for (const method of methods) {
		// See detectCalcFieldsInLoop for why ALL candidates must be iterated.
		const matches = matchAllToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);

		for (const match of matches) {
			const opsInLoop = match.features.recordOpsInLoops.filter(
				(op) =>
					(op.type === "Delete" || op.type === "DeleteAll") &&
					!isTemporaryOp(
						op,
						match.features.variables,
						ownerObject(match, index),
					) &&
					!isKnownNonRecordOp(op, match.features.variables),
			);

			for (const op of opsInLoop) {
				const severity = downgradePageImplicitLoop("critical", op);
				const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
				patterns.push({
					id: "delete-in-loop",
					severity,
					title: `${op.type} inside loop in ${method.functionName}`,
					description: `${op.type}()${recVar} ${loopLocationPhrase(op, op.line, match.file)}. Each iteration issues a separate SQL DELETE, which can be very slow for large datasets.`,
					impact: method.selfTime,
					involvedMethods: [methodLabel(method)],
					evidence: `${op.type}() at line ${op.line}, column ${op.column} — ${loopEvidencePhrase(op)}`,
					suggestion:
						"Use DeleteAll() with a filter instead of deleting row by row. If this call already is DeleteAll(), the loop around it is the bug — DeleteAll() exists to replace the loop, not to run inside one.",
				});
			}
		}
	}

	return patterns;
}

/**
 * Detect record lookup operations (FindSet/FindFirst/FindLast/Find/Get) inside loops.
 * Severity: critical.
 */
export function detectRecordOpInLoop(
	methods: MethodBreakdown[],
	index: SourceIndex,
): DetectedPattern[] {
	const LOOKUP_OPS = new Set([
		"FindSet",
		"FindFirst",
		"FindLast",
		"Find",
		"Get",
	]);
	const patterns: DetectedPattern[] = [];

	for (const method of methods) {
		// See detectCalcFieldsInLoop for why ALL candidates must be iterated.
		const matches = matchAllToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);

		for (const match of matches) {
			const opsInLoop = match.features.recordOpsInLoops.filter(
				(op) =>
					LOOKUP_OPS.has(op.type) &&
					!isTemporaryOp(
						op,
						match.features.variables,
						ownerObject(match, index),
					) &&
					!isKnownNonRecordOp(op, match.features.variables),
			);

			for (const op of opsInLoop) {
				const severity = downgradePageImplicitLoop("critical", op);
				const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
				patterns.push({
					id: "record-op-in-loop",
					severity,
					title: `${op.type} inside loop in ${method.functionName}`,
					description: `${op.type}()${recVar} ${loopLocationPhrase(op, op.line, match.file)}. Each iteration triggers a separate SQL query.`,
					impact: method.selfTime,
					involvedMethods: [methodLabel(method)],
					evidence: `${op.type}() at line ${op.line}, column ${op.column} — ${loopEvidencePhrase(op)}`,
					suggestion:
						"Restructure to reduce database calls inside the loop. Consider loading data before the loop with a single query.",
				});
			}
		}
	}

	return patterns;
}

/**
 * Compare two source positions in "does A run strictly before B" order. Two
 * ops commonly land on the same physical line in AL (e.g.
 * `Rec.SetLoadFields(...); if Rec.FindSet() then ...;`) -- comparing line
 * numbers alone treats an equal line as "not yet run", which flags code that
 * is actually correctly ordered.
 */
function isPositionBefore(
	a: { line: number; column: number },
	b: { line: number; column: number },
): boolean {
	return a.line !== b.line ? a.line < b.line : a.column < b.column;
}

/**
 * A single `SetLoadFields()` call, tracked with its position and (for a
 * restrictive call) the field set it loads.
 */
interface SetLoadFieldsOp {
	line: number;
	column: number;
	/** Lowercased field names this call loads. Empty for a bare reset -- see `isBareReset`; that means "loads ALL fields", never "loads zero fields". */
	fields: Set<string>;
	/** True for a bare `SetLoadFields()` call with no arguments -- per Microsoft's docs it resets to loading ALL fields, not zero. */
	isBareReset: boolean;
}

/**
 * Every `SetLoadFields()` call per (lowercased) record variable in a method,
 * in source order (ascending by `(line, column)`).
 *
 * Shared by detectMissingSetLoadFields and detectIncompleteSetLoadFields,
 * which ask two DIFFERENT questions about the same calls and must not
 * silently drift back apart on the temp-record guard or the bare-reset rule
 * -- that drift is exactly how this file shipped a live critical false
 * positive once already (see git history on this function):
 *
 * - detectMissingSetLoadFields asks "was there ANY restriction before this
 *   find?" -- the mere EXISTENCE of a preceding restrictive call answers
 *   that; which one, or how many, doesn't matter.
 * - detectIncompleteSetLoadFields asks "what fields does this variable have
 *   loaded AT THE MOMENT of this specific access?" -- that is answered by
 *   the LAST call before the access, never the earliest. A later, narrower
 *   (or wider, or bare-reset) SetLoadFields call REPLACES the field set from
 *   an earlier one; it does not union with it. Anchoring this detector on
 *   the earliest call (the previous shape of this function) evaluated an
 *   access against a call that was no longer in effect by the time that
 *   access ran -- e.g. `SetLoadFields(A); Find; Read(A); SetLoadFields(B);
 *   Find; Read(B)` -- both reads genuinely covered -- was flagged as
 *   "missing B" because it compared B against SetLoadFields(A)'s field set.
 *   That is a critical-severity false positive on correct code.
 *
 * Two things never anchor coverage for either detector:
 * - Temporary records: SetLoadFields is a no-op on a temp record (no SQL
 *   load happens), so neither detector has anything to say about them. Ops
 *   on a temp variable are excluded from the map entirely.
 * - A bare `SetLoadFields()` call with zero field arguments never counts as
 *   a *restriction* -- per Microsoft's docs it resets to loading ALL fields.
 *   It IS still tracked here (`isBareReset: true`, empty `fields`) because
 *   detectIncompleteSetLoadFields needs it: a bare reset satisfies every
 *   field access that comes after it, even though by itself it restricts
 *   nothing (so detectMissingSetLoadFields must not treat it as coverage).
 */
function setLoadFieldsOpsByVar(
	allOps: RecordOpInfo[],
	variables: VariableInfo[],
): Map<string, SetLoadFieldsOp[]> {
	const result = new Map<string, SetLoadFieldsOp[]>();

	for (const op of allOps) {
		if (op.type !== "SetLoadFields" || !op.recordVariable) continue;
		if (isTemporaryOp(op, variables)) continue; // no SQL load on a temp record

		const isBareReset =
			op.allFieldArguments !== undefined && op.allFieldArguments.length === 0;
		const fields = new Set<string>();
		if (op.allFieldArguments) {
			for (const f of op.allFieldArguments) fields.add(f.toLowerCase());
		} else if (op.fieldArgument) {
			fields.add(op.fieldArgument.toLowerCase());
		}

		const key = op.recordVariable.toLowerCase();
		const entry: SetLoadFieldsOp = {
			line: op.line,
			column: op.column,
			fields,
			isBareReset,
		};
		const list = result.get(key);
		if (list) list.push(entry);
		else result.set(key, [entry]);
	}

	for (const list of result.values()) {
		list.sort((a, b) => {
			if (isPositionBefore(a, b)) return -1;
			if (isPositionBefore(b, a)) return 1;
			return 0;
		});
	}

	return result;
}

/**
 * The last `SetLoadFields()` call that ran strictly before `position` --
 * i.e. what that record variable's field coverage actually looked like at
 * that point in the method. `undefined` when no call precedes `position`
 * yet. `ops` must already be ascending by position (see
 * `setLoadFieldsOpsByVar`).
 */
function lastSetLoadFieldsOpBefore(
	ops: SetLoadFieldsOp[],
	position: { line: number; column: number },
): SetLoadFieldsOp | undefined {
	let result: SetLoadFieldsOp | undefined;
	for (const op of ops) {
		if (!isPositionBefore(op, position)) break; // ascending order -- nothing later can qualify either
		result = op;
	}
	return result;
}

/**
 * Detect FindSet/FindFirst/FindLast without a preceding SetLoadFields on the same record variable.
 * Severity: warning.
 */
export function detectMissingSetLoadFields(
	methods: MethodBreakdown[],
	index: SourceIndex,
): DetectedPattern[] {
	const FIND_OPS = new Set(["FindSet", "FindFirst", "FindLast"]);
	const patterns: DetectedPattern[] = [];

	for (const method of methods) {
		// See detectCalcFieldsInLoop for why ALL candidates must be iterated.
		const matches = matchAllToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);

		for (const match of matches) {
			const allOps = match.features.recordOps;
			const findOps = allOps.filter((op) => FIND_OPS.has(op.type));
			const opsByVar = setLoadFieldsOpsByVar(allOps, match.features.variables);

			for (const op of findOps) {
				if (
					isTemporaryOp(op, match.features.variables, ownerObject(match, index))
				)
					continue; // no SQL load on a temp record
				// FIND_OPS matches method NAMES, and RecordRef/Query have
				// FindFirst/FindSet too. Fails open on an unresolved receiver, so
				// object-level globals and a page's implicit Rec keep reporting.
				if (isKnownNonRecordOp(op, match.features.variables)) continue;
				const recVarLower = op.recordVariable?.toLowerCase() ?? "";
				const ops = opsByVar.get(recVarLower) ?? [];
				// Covered if ANY restrictive (non-bare-reset) call precedes this find --
				// a bare reset still loads every field, so it must not suppress this
				// warning (see setLoadFieldsOpsByVar).
				const isCovered = ops.some(
					(o) => !o.isBareReset && isPositionBefore(o, op),
				);
				if (!isCovered) {
					const recVar = op.recordVariable ? ` on ${op.recordVariable}` : "";
					// SetLoadFields is only safe advice when every field read is
					// visible in this member. If the record is handed to a callee,
					// or a table method is called on it, fields nobody here names
					// may be read from it — and narrowing the load starves exactly
					// those reads. The finding stands (the opportunity may be real)
					// but stops reading as a fix that can be applied blind.
					const escapes =
						match.features.escapedRecordVariables.includes(recVarLower);
					patterns.push({
						id: "missing-setloadfields",
						severity: escapes ? "info" : "warning",
						title: `${op.type} without SetLoadFields in ${method.functionName}`,
						description: `${op.type}()${recVar} at line ${op.line} in ${match.file} has no preceding SetLoadFields(). This loads all fields from the database when only a subset may be needed.`,
						impact: method.selfTime,
						involvedMethods: [methodLabel(method)],
						evidence: `${op.type}() at line ${op.line} without SetLoadFields for ${op.recordVariable ?? "unknown variable"}`,
						suggestion: escapes
							? `Check what reads ${op.recordVariable ?? "this record"} elsewhere before adding SetLoadFields() — it is passed on, or has a table method called on it, so fields not named in this member may be read from it. Narrowing the load without covering those is worse than leaving it alone.`
							: "Add SetLoadFields() before record retrieval to load only the fields you need, reducing I/O.",
					});
				}
			}
		}
	}

	return patterns;
}

/**
 * Detect SetLoadFields that doesn't cover all fields later accessed.
 * Severity: critical (will cause runtime errors or wrong values).
 */
export function detectIncompleteSetLoadFields(
	methods: MethodBreakdown[],
	index: SourceIndex,
): DetectedPattern[] {
	const patterns: DetectedPattern[] = [];

	for (const method of methods) {
		// See detectCalcFieldsInLoop for why ALL candidates must be iterated.
		const matches = matchAllToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);

		for (const match of matches) {
			const allOps = match.features.recordOps;
			const fieldAccesses = match.features.fieldAccesses;
			const opsByVar = setLoadFieldsOpsByVar(allOps, match.features.variables);

			for (const [varLower, ops] of opsByVar) {
				const accessesForVar = fieldAccesses.filter(
					(a) => a.recordVariable.toLowerCase() === varLower,
				);
				if (accessesForVar.length === 0) continue;

				// `Rec.SomeName` with no parentheses is a field read OR a
				// paren-less call to a table PROCEDURE — collectFieldAccesses
				// cannot tell them apart, and records both as field accesses.
				// The table's own field list can: `Email.HasMoreDocuments` is
				// `internal procedure HasMoreDocuments(): Boolean`, and reporting
				// it as a forgotten field produced a critical finding claiming
				// runtime errors about a method call.
				//
				// When the table is NOT in the index (a base-app or dependency
				// table) there is no way to tell the two apart, so the finding
				// stands but stops claiming certainty it does not have. All 16
				// findings on one real codebase were in that state.
				const variable = match.features.variables.find(
					(v) => v.name.toLowerCase() === varLower,
				);
				// The RESOLVED table: the root declaration plus every indexed
				// tableextension. An ambiguous name is two different tables, so
				// it is treated exactly as an absent one.
				const resolvedTable = variable?.tableName
					? index.tables.get(variable.tableName.toLowerCase())
					: undefined;
				const table =
					resolvedTable && !resolvedTable.ambiguous ? resolvedTable : undefined;

				// Fields we can positively confirm. Present on a fragment too —
				// a field that is present IS a field, whether or not the root
				// was indexed.
				const confirmedFields = table
					? new Map(table.fields.map((f) => [f.name.toLowerCase(), f]))
					: undefined;
				// Only a root-seen table can support the NEGATIVE claim "this
				// name is not a field, so it is a paren-less method call". On a
				// fragment an absent name proves nothing.
				const closedFieldList = table?.rootSeen === true;

				// BC ALWAYS loads the primary key — SetLoadFields cannot exclude
				// the fields that identify the record, and SystemId rides along
				// with them. The primary key is the ROOT's first key and only
				// ever the root's: an extension key is a secondary key by BC
				// definition, so a fragment has no primary key to know.
				// Microsoft's partial-records FAQ: a field can be excluded from
				// a load set only if it "isn't a FlowField, FlowFilter, Primary
				// Key, Timestamp, SystemId, Audit Fields, or Blobs". Verified
				// on BC 28 rather than taken on faith — reading
				// SystemModifiedAt after SetLoadFields(Description) cost 1 SQL
				// statement against a baseline of 1, where a genuinely
				// unloaded field cost 4 (private/alwaysloaded-probe). These
				// are name-based so they hold even for a table that is not in
				// the index; Blobs are type-based and are handled with the
				// FlowField guard below.
				const alwaysLoaded = new Set<string>([
					"systemid",
					"timestamp",
					"systemcreatedat",
					"systemcreatedby",
					"systemmodifiedat",
					"systemmodifiedby",
				]);
				for (const f of table?.primaryKey?.fields ?? []) {
					alwaysLoaded.add(f.toLowerCase());
				}

				// Resolve coverage PER ACCESS: what did this variable's field set
				// actually look like at the moment THIS access ran? That is the LAST
				// SetLoadFields call before the access, not the earliest -- a later
				// call replaces the field set from an earlier one, it does not union
				// with it. Group any misses by the call that governed them, since two
				// accesses in the same method can be governed by two different calls.
				const missingByOp = new Map<SetLoadFieldsOp, Set<string>>();

				for (const access of accessesForVar) {
					const governingOp = lastSetLoadFieldsOpBefore(ops, access);
					if (governingOp === undefined) continue; // no coverage yet here -- missing-setloadfields' job, not this one's; reporting it here too would double-report the same bug
					if (governingOp.isBareReset) continue; // bare reset loads every field -- covered

					const fieldLower = access.fieldName.toLowerCase();
					if (governingOp.fields.has(fieldLower)) continue;
					if (alwaysLoaded.has(fieldLower)) continue;

					const confirmed = confirmedFields?.get(fieldLower);
					// SetLoadFields accepts normal fields only. Telling someone
					// to add a FlowField or a FlowFilter to the list produces
					// code that does not compile.
					//
					// FieldClass is checked as well as calcFormulaType, not
					// instead of it: a FlowField whose CalcFormula the extractor
					// cannot type has no calcFormulaType at all, and keying the
					// guard on that alone let 130 corpus fields through. Four
					// remain untypeable even after `findCalcFormulaNode` learned
					// the no-`where` and negated shapes, and the next
					// unrecognised formula shape would silently reopen this.
					const confirmedClass = confirmed?.fieldClass?.toLowerCase();
					// A Blob is always loaded too, and unlike the audit fields
					// it can only be recognised by TYPE — it is a real declared
					// field, so it resolves as confirmed and was reported as a
					// forgotten one. 4 findings on each of two real corpora.
					const isBlob = confirmed?.dataType?.toLowerCase() === "blob";
					if (
						confirmed?.calcFormulaType !== undefined ||
						confirmedClass === "flowfilter" ||
						confirmedClass === "flowfield" ||
						isBlob
					) {
						continue;
					}
					// Not a field of a table whose field list is CLOSED => a
					// paren-less table method call, not a forgotten field. On a
					// fragment the same absence proves nothing, so the finding
					// stands and hedges instead.
					if (closedFieldList && !confirmed) continue;
					// …except that some names need no field list to settle.
					// `Rec.ReadPermission` is a Record BUILT-IN, a field of no
					// table, and it parses exactly like `Rec."Document No."`.
					// Hedging over it claims an uncertainty the tool does not
					// have. Applied only where the field list is NOT closed —
					// a known table has already answered, and answered better,
					// since `Number` and `RecordID` are legal field names.
					if (!closedFieldList && PARENLESS_RECORD_BUILTINS.has(fieldLower)) {
						continue;
					}

					const missing = missingByOp.get(governingOp) ?? new Set<string>();
					missing.add(fieldLower);
					missingByOp.set(governingOp, missing);
				}

				for (const [op, missingFieldsSet] of missingByOp) {
					const missingFields = [...missingFieldsSet];
					const recVar = accessesForVar[0]?.recordVariable ?? varLower;
					// Certainty requires that every reported name be a
					// CONFIRMED field. One unconfirmable name in the list drops
					// the whole finding to warning, because that name may be a
					// paren-less method call rather than a forgotten field.
					const allConfirmed =
						confirmedFields !== undefined &&
						missingFields.every((f) => confirmedFields.has(f));
					// Name the names that are actually in doubt. The hedge used
					// to say "these names could not be confirmed to be fields at
					// all" about the WHOLE list, which is untrue as soon as one
					// governing SetLoadFields covers a confirmed field and an
					// unconfirmable one together — the confirmed one was
					// confirmed.
					const unconfirmed = missingFields.filter(
						(f) => !confirmedFields?.has(f),
					);
					// A PERFORMANCE finding, not a correctness one, and the
					// cost model below is MEASURED on BC 28 rather than read
					// off the docs (private/jit-probe, `SessionInformation.
					// SqlStatementsExecuted`, 5,000 rows per scenario in
					// disjoint ranges so no scenario warms the cache for
					// another):
					//
					//   no SetLoadFields at all ......... 1 SQL statement
					//   load set COVERS the reads ....... 1
					//   reads a field NOT in the set .... 4   (5002 rows read)
					//   same, via a by-value parameter .. 4   (5002 rows read)
					//
					// So it is NOT one round-trip per iteration — 5,000
					// iterations cost 4 statements, not 5,000. Accessing an
					// unloaded field JIT-loads it (an implicit Get), and the
					// platform then adds that field to the load set for the
					// rest of the iteration. That is the real cost: three extra
					// statements once, and then the narrowing simply stops
					// applying, which is what SetLoadFields was for.
					//
					// Errors — "Inconsistent read of field(s)" / "JIT loading
					// of field(s) failed" — are possible but only under a race,
					// when another session modifies, deletes or renames the row
					// between the two loads.
					//
					// So `warning`, not `critical`. The old rating rested on a
					// "will cause runtime errors" claim that is not what BC
					// does. (The docs say a by-value copy JIT-loads on every
					// iteration; this shape measured 4 statements either way on
					// BC 28, so that is not asserted here.)
					patterns.push({
						id: "incomplete-setloadfields",
						severity: allConfirmed ? "warning" : "info",
						title: `SetLoadFields on ${recVar} in ${method.functionName} is missing accessed fields`,
						description: allConfirmed
							? `SetLoadFields() on ${recVar} loads [${[...op.fields].join(", ")}] but the code later accesses [${missingFields.join(", ")}]. Reading a field that was not loaded triggers a JIT load — an implicit Get — and the platform then adds that field to the load set for the rest of the iteration, so the narrowing stops applying from that point on. Measured on BC 28: 5,000 iterations cost 4 SQL statements against 1 for a covering load set, so the cost is a small constant, not one round-trip per row. Under concurrent modification a JIT load can also fail with "Inconsistent read of field(s)".`
							: `SetLoadFields() on ${recVar} loads [${[...op.fields].join(", ")}] but the code later accesses [${missingFields.join(", ")}]. Table "${variable?.tableName ?? "?"}" is ${table ? "only known from its extensions — its root declaration is not in the index" : "not in the index"}, so ${unconfirmed.join(", ")} could not be confirmed to be ${unconfirmed.length === 1 ? "a field" : "fields"} at all — a paren-less call to a table method reads identically here.`,
						impact: method.selfTime,
						involvedMethods: [methodLabel(method)],
						evidence: `SetLoadFields loads ${op.fields.size} field(s), but ${missingFields.length} additional field(s) are accessed: ${missingFields.join(", ")}`,
						suggestion: `Add the missing fields to SetLoadFields so they load with the record instead of costing an extra Get: ${missingFields.map((f) => `"${f}"`).join(", ")}`,
					});
				}
			}
		}
	}

	return patterns;
}

/**
 * Build a synthetic `MethodBreakdown` per DISTINCT `(functionName, objectType,
 * objectId)` triple indexed in a `SourceIndex`, for running the
 * source-correlated detectors with no profile at all (the `analyze-source`
 * CLI command). Every profile-derived field is zeroed — there is no captured
 * timing here, only structure — but `functionName`/`objectType`/`objectId`
 * are exactly what `matchAllToSource` needs to resolve each synthetic method
 * back to every procedure/trigger it was built from, so `runSourceDetectors`
 * sees the real `recordOpsInLoops`/`recordOps` for every member in the index.
 *
 * Exists so a profile-less caller can reuse the real detectors — with their
 * real severities, real implicit-loop self-explanation, and real
 * temp/non-record guards — instead of re-deriving a second, drifting copy of
 * that logic inline (see the whole-branch review that found exactly that
 * drift: `insert-in-loop | info` and `delete-in-loop | info` — including on
 * temporary records — where the real detectors say `critical` and exclude
 * temp records).
 *
 * DEDUPED by `(name, objectType, objectId)` — this is load-bearing, not
 * cosmetic. Triggers are not name-unique within an object (a report with two
 * dataitems has two `OnAfterGetRecord` members; a table with two field
 * `OnValidate` triggers has two `OnValidate` members). Each detector now
 * calls `matchAllToSource`, which resolves a `(name, objectType, objectId)`
 * key to EVERY matching member at once. Emitting one synthetic method per
 * RAW member (the pre-fix behavior) would mean N members all sharing that key
 * each independently re-resolving to all N candidates — N × N duplicate
 * findings, not N. Emitting one synthetic method per distinct key instead
 * means each key is resolved exactly once, against all N real candidates,
 * producing exactly N findings.
 */
export function syntheticMethodsFromIndex(
	index: SourceIndex,
): MethodBreakdown[] {
	const methods: MethodBreakdown[] = [];
	const seen = new Set<string>();
	for (const obj of index.objects.values()) {
		for (const member of [...obj.procedures, ...obj.triggers]) {
			const key = `${member.name.toLowerCase()}|${obj.objectType}|${obj.objectId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			methods.push({
				functionName: member.name,
				objectType: obj.objectType,
				objectName: obj.objectName,
				objectId: obj.objectId,
				appName: "",
				selfTime: 0,
				selfTimePercent: 0,
				totalTime: 0,
				totalTimePercent: 0,
				hitCount: 0,
				calledBy: [],
				calls: [],
				costPerHit: 0,
				efficiencyScore: 0,
			});
		}
	}
	return methods;
}

/**
 * Run all source-correlated pattern detectors and return results sorted by impact descending.
 */
export function runSourceDetectors(
	methods: MethodBreakdown[],
	index: SourceIndex,
): DetectedPattern[] {
	const allPatterns: DetectedPattern[] = [
		...detectCalcFieldsInLoop(methods, index),
		...detectModifyInLoop(methods, index),
		...detectInsertInLoop(methods, index),
		...detectDeleteInLoop(methods, index),
		...detectRecordOpInLoop(methods, index),
		...detectMissingSetLoadFields(methods, index),
		...detectIncompleteSetLoadFields(methods, index),
	];

	return sortPatterns(allPatterns);
}
