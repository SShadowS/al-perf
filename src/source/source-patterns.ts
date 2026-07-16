import { sortPatterns } from "../core/patterns.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern } from "../types/patterns.js";
import type {
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
import { matchAllToSource } from "./locator.js";

/**
 * Check if a record operation targets a temporary variable.
 */
export function isTemporaryOp(
	op: RecordOpInfo,
	variables: VariableInfo[],
): boolean {
	if (!op.recordVariable) return false;
	const variable = variables.find(
		(v) => v.name.toLowerCase() === op.recordVariable!.toLowerCase(),
	);
	return variable?.isTemporary === true;
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
 * Falls back to the table's full FlowField set only when the call's field
 * list is unknown — a bare `CalcFields();` with no arguments calculates
 * every FlowField on the record, so the table's full set genuinely is the
 * true answer there, not a guess.
 *
 * Returns `undefined` when nothing can be resolved: the record variable
 * isn't a known Record, its table isn't in the index, or the named field(s)
 * don't match any indexed FlowField on that table. Callers must not assert
 * anything about the field's type when this is `undefined` — silence is the
 * honest answer, not a confident guess.
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
	// here. That makes this resolution — and the severity it feeds — inert
	// for every implicit-loop calcfields-in-loop finding: it always falls
	// back to the conservative `critical` default regardless of which field
	// is actually being calculated. Fails safe (over-severe, never
	// under-severe); pre-existing behavior, not fixed by this change.
	if (!variable?.isRecord || !variable.tableName) return undefined;

	for (const obj of index.objects.values()) {
		if (obj.objectType !== "Table" || obj.objectName !== variable.tableName)
			continue;

		const calledFields = op.allFieldArguments;
		if (!calledFields || calledFields.length === 0) {
			const allFlowFields = obj.fields.filter((f) => f.calcFormulaType);
			return allFlowFields.length > 0 ? allFlowFields : undefined;
		}

		const calledLower = new Set(calledFields.map((f) => f.toLowerCase()));
		const resolved = obj.fields.filter(
			(f) => f.calcFormulaType && calledLower.has(f.name.toLowerCase()),
		);
		return resolved.length > 0 ? resolved : undefined;
	}

	return undefined; // Table not found in the index — nothing known.
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
 * The factual "this table has ... FlowFields" clause of the suggestion.
 * Must only ever be called with a resolved field list (see
 * `resolveCalcFields`) — never derived from severity alone, which can be a
 * conservative default rather than actual knowledge of the field's type.
 */
function calcFieldFactSentence(resolved: TableFieldInfo[]): string {
	if (resolved.some((f) => AGGREGATION_CALC_TYPES.has(f.calcFormulaType))) {
		return "This table has aggregation FlowFields (Sum/Count), which force a SQL aggregation per call.";
	}
	if (resolved.every((f) => f.calcFormulaType === "Exist")) {
		return "This table has an Exist FlowField — cheaper than Sum/Count since SQL can short-circuit on the first matching row, but still one query per iteration.";
	}
	return "This table has Lookup FlowFields — cheaper than Sum/Count, but still one SQL query per iteration.";
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
					!isTemporaryOp(op, match.features.variables) &&
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
					!isTemporaryOp(op, match.features.variables) &&
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
					!isTemporaryOp(op, match.features.variables) &&
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
					!isTemporaryOp(op, match.features.variables) &&
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
					!isTemporaryOp(op, match.features.variables) &&
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
				if (isTemporaryOp(op, match.features.variables)) continue; // no SQL load on a temp record
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
					patterns.push({
						id: "missing-setloadfields",
						severity: "warning",
						title: `${op.type} without SetLoadFields in ${method.functionName}`,
						description: `${op.type}()${recVar} at line ${op.line} in ${match.file} has no preceding SetLoadFields(). This loads all fields from the database when only a subset may be needed.`,
						impact: method.selfTime,
						involvedMethods: [methodLabel(method)],
						evidence: `${op.type}() at line ${op.line} without SetLoadFields for ${op.recordVariable ?? "unknown variable"}`,
						suggestion:
							"Add SetLoadFields() before record retrieval to load only the fields you need, reducing I/O.",
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

					const missing = missingByOp.get(governingOp) ?? new Set<string>();
					missing.add(fieldLower);
					missingByOp.set(governingOp, missing);
				}

				for (const [op, missingFieldsSet] of missingByOp) {
					const missingFields = [...missingFieldsSet];
					const recVar = accessesForVar[0]?.recordVariable ?? varLower;
					patterns.push({
						id: "incomplete-setloadfields",
						severity: "critical",
						title: `SetLoadFields on ${recVar} in ${method.functionName} is missing accessed fields`,
						description: `SetLoadFields() on ${recVar} loads [${[...op.fields].join(", ")}] but the code later accesses [${missingFields.join(", ")}]. These fields will return default values or cause runtime errors.`,
						impact: method.selfTime,
						involvedMethods: [methodLabel(method)],
						evidence: `SetLoadFields loads ${op.fields.size} field(s), but ${missingFields.length} additional field(s) are accessed: ${missingFields.join(", ")}`,
						suggestion: `Add the missing fields to SetLoadFields: ${missingFields.map((f) => `"${f}"`).join(", ")}`,
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
