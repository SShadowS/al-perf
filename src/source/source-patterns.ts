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
import { matchToSource } from "./locator.js";

/**
 * Check if a record operation targets a temporary variable.
 */
function isTemporaryOp(op: RecordOpInfo, variables: VariableInfo[]): boolean {
	if (!op.recordVariable) return false;
	const variable = variables.find(
		(v) => v.name.toLowerCase() === op.recordVariable!.toLowerCase(),
	);
	return variable?.isTemporary === true;
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
 * Build the calcfields-in-loop suggestion text. The SetAutoCalcFields
 * recommendation and the "SetLoadFields does NOT help" disclaimer always
 * apply, regardless of what is known about the field. The "this table has X
 * FlowFields" fact sentence is conditional on `resolved` — omitted entirely
 * when the field didn't resolve, so the tool never asserts a FlowField type
 * it doesn't actually know (see `resolveCalcFields`).
 */
function calcFieldsSuggestion(
	severity: "critical" | "warning",
	resolved: TableFieldInfo[] | undefined,
): string {
	const action =
		severity === "critical"
			? "Call SetAutoCalcFields() before the loop so the FlowField is calculated as each record is retrieved, or filter on the FlowField instead of calculating it per row."
			: "Call SetAutoCalcFields() before the loop so the FlowField is calculated as each record is retrieved.";
	const fact = resolved ? ` ${calcFieldFactSentence(resolved)}` : "";
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
		const match = matchToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);
		if (!match) continue;

		const opsInLoop = match.features.recordOpsInLoops.filter(
			(op) =>
				(op.type === "CalcFields" || op.type === "CalcSums") &&
				!isTemporaryOp(op, match.features.variables),
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
				suggestion: calcFieldsSuggestion(severity, resolvedFields),
			});
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
		const match = matchToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);
		if (!match) continue;

		const opsInLoop = match.features.recordOpsInLoops.filter(
			(op) =>
				(op.type === "Modify" || op.type === "ModifyAll") &&
				!isTemporaryOp(op, match.features.variables),
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
		const match = matchToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);
		if (!match) continue;

		const opsInLoop = match.features.recordOpsInLoops.filter(
			(op) =>
				op.type === "Insert" && !isTemporaryOp(op, match.features.variables),
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
		const match = matchToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);
		if (!match) continue;

		const opsInLoop = match.features.recordOpsInLoops.filter(
			(op) =>
				(op.type === "Delete" || op.type === "DeleteAll") &&
				!isTemporaryOp(op, match.features.variables),
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
		const match = matchToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);
		if (!match) continue;

		const opsInLoop = match.features.recordOpsInLoops.filter(
			(op) =>
				LOOKUP_OPS.has(op.type) && !isTemporaryOp(op, match.features.variables),
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

	return patterns;
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
		const match = matchToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);
		if (!match) continue;

		const allOps = match.features.recordOps;
		const findOps = allOps.filter((op) => FIND_OPS.has(op.type));

		// Collect all record variables that have SetLoadFields
		const setLoadFieldsVars = new Set<string>();
		for (const op of allOps) {
			if (op.type === "SetLoadFields" && op.recordVariable) {
				setLoadFieldsVars.add(op.recordVariable.toLowerCase());
			}
		}

		for (const op of findOps) {
			const recVarLower = op.recordVariable?.toLowerCase() ?? "";
			if (!setLoadFieldsVars.has(recVarLower)) {
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
		const match = matchToSource(
			method.functionName,
			method.objectType,
			method.objectId,
			index,
		);
		if (!match) continue;

		const allOps = match.features.recordOps;
		const fieldAccesses = match.features.fieldAccesses;

		// Group SetLoadFields calls by record variable
		const loadFieldsByVar = new Map<string, Set<string>>();
		for (const op of allOps) {
			if (op.type === "SetLoadFields" && op.recordVariable) {
				const varLower = op.recordVariable.toLowerCase();
				if (!loadFieldsByVar.has(varLower)) {
					loadFieldsByVar.set(varLower, new Set());
				}
				if (op.allFieldArguments) {
					for (const f of op.allFieldArguments) {
						loadFieldsByVar.get(varLower)!.add(f.toLowerCase());
					}
				} else if (op.fieldArgument) {
					loadFieldsByVar.get(varLower)!.add(op.fieldArgument.toLowerCase());
				}
			}
		}

		// For each variable that has SetLoadFields, check if all accessed fields are covered
		for (const [varLower, loadedFields] of loadFieldsByVar) {
			const accessedFields = fieldAccesses
				.filter((a) => a.recordVariable.toLowerCase() === varLower)
				.map((a) => a.fieldName.toLowerCase());

			const uniqueAccessed = [...new Set(accessedFields)];
			const missingFields = uniqueAccessed.filter((f) => !loadedFields.has(f));

			if (missingFields.length > 0) {
				const recVar =
					fieldAccesses.find((a) => a.recordVariable.toLowerCase() === varLower)
						?.recordVariable ?? varLower;
				patterns.push({
					id: "incomplete-setloadfields",
					severity: "critical",
					title: `SetLoadFields on ${recVar} in ${method.functionName} is missing accessed fields`,
					description: `SetLoadFields() on ${recVar} loads [${[...loadedFields].join(", ")}] but the code later accesses [${missingFields.join(", ")}]. These fields will return default values or cause runtime errors.`,
					impact: method.selfTime,
					involvedMethods: [methodLabel(method)],
					evidence: `SetLoadFields loads ${loadedFields.size} field(s), but ${missingFields.length} additional field(s) are accessed: ${missingFields.join(", ")}`,
					suggestion: `Add the missing fields to SetLoadFields: ${missingFields.map((f) => `"${f}"`).join(", ")}`,
				});
			}
		}
	}

	return patterns;
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

	allPatterns.sort((a, b) => b.impact - a.impact);

	return allPatterns;
}
