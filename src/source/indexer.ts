import { readFileSync } from "fs";
import { relative } from "path";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type {
	ALFileInfo,
	DangerousCallInfo,
	ExternalCallInfo,
	FieldAccessInfo,
	LoopInfo,
	ObjectInfo,
	ProcedureFeatures,
	ProcedureInfo,
	RecordOpInfo,
	RecordOpType,
	SourceIndex,
	TableFieldInfo,
	TableKeyInfo,
	TriggerInfo,
	VariableInfo,
} from "../types/source-index.js";
import type { ImplicitLoopAware } from "./implicit-loop.js";
import { parseALSource } from "./parser-init.js";

const RECORD_OPS: Set<string> = new Set([
	"findset",
	"findfirst",
	"findlast",
	"find",
	"get",
	"calcfields",
	"calcsums",
	"modify",
	"modifyall",
	"insert",
	"delete",
	"deleteall",
	"setloadfields",
	"setrange",
	"setfilter",
	"reset",
	"next",
	"count",
	"countapprox",
	"isempty",
]);

/** Map from canonical lowercase record op name to its properly-cased RecordOpType */
const RECORD_OP_CASE_MAP: Record<string, RecordOpType> = {
	findset: "FindSet",
	findfirst: "FindFirst",
	findlast: "FindLast",
	find: "Find",
	get: "Get",
	calcfields: "CalcFields",
	calcsums: "CalcSums",
	modify: "Modify",
	modifyall: "ModifyAll",
	insert: "Insert",
	delete: "Delete",
	deleteall: "DeleteAll",
	setloadfields: "SetLoadFields",
	setrange: "SetRange",
	setfilter: "SetFilter",
	reset: "Reset",
	next: "Next",
	count: "Count",
	countapprox: "CountApprox",
	isempty: "IsEmpty",
};

const OBJECT_TYPE_MAP: Record<string, string> = {
	codeunit_declaration: "Codeunit",
	table_declaration: "Table",
	page_declaration: "Page",
	report_declaration: "Report",
	query_declaration: "Query",
	xmlport_declaration: "XMLport",
	enum_declaration: "Enum",
	interface_declaration: "Interface",
	controladdin_declaration: "ControlAddIn",
	tableextension_declaration: "TableExtension",
	pageextension_declaration: "PageExtension",
	enumextension_declaration: "EnumExtension",
	reportextension_declaration: "ReportExtension",
	permissionset_declaration: "PermissionSet",
};

/**
 * Object types whose procedures/triggers see an implicit, unqualified record
 * variable -- a bare `FindSet();`, `Modify();`, `CalcFields(Amount);` with no
 * receiver is a record operation there, not a local procedure call. A
 * Codeunit has no implicit record, so a bare `Get(...)` there is a normal
 * procedure call and must NOT be collected.
 *
 * `TableExtension`/`PageExtension`/`ReportExtension` are included alongside
 * their base types for the same reason Task 7 added per-row triggers for
 * extensions: in BC you cannot modify base tables/pages/reports directly, so
 * partner and ISV code overwhelmingly lives in extension objects. Leaving
 * these out would keep the tool blind in exactly the population where real
 * AL code sits, even though the base-type gate was "fixed".
 *
 * Values are exactly the reachable strings `OBJECT_TYPE_MAP` produces above
 * (note `"XMLport"`, not `"XmlPort"`). There is no `OBJECT_TYPE_MAP` value
 * that is literally `"RequestPage"` -- a requestpage is a
 * `requestpage_section` nested inside a report/XMLport's `declaration_body`
 * (verified against `node-types.json`; there is no `requestpage_declaration`
 * node), so its code is already indexed under the enclosing report/XMLport's
 * own objectType and needs no entry of its own here. A key that can never
 * match type-checks fine and silently does nothing (per Task 7's own casing
 * warning), so it is deliberately left out.
 */
const IMPLICIT_RECORD_OBJECT_TYPES = new Set([
	"Table",
	"Page",
	"Report",
	"XMLport",
	"TableExtension",
	"PageExtension",
	"ReportExtension",
]);

/**
 * Object types whose implicit record only exists *inside* a dataitem
 * (Report) / tableelement (XMLport), and whose name IS that dataitem's own
 * instance name, not the literal identifier `Rec` -- reports/XMLports have
 * no variable actually named `Rec`. `ReportExtension` shares this shape: a
 * dataitem it adds via `addfirst`/`addlast` is the same `report_dataitem`
 * node as a base report's.
 *
 * A bare call in one of these object types OUTSIDE any dataitem (e.g. a
 * report's global helper procedure) has no implicit record at all -- there
 * is no dataitem in scope to name it after, and it must NOT be collected
 * against a phantom `"Rec"` that doesn't exist in a report/XMLport. `Table`/
 * `Page` (and their extensions) are deliberately absent from this set: they
 * have no dataitem wrapper, so their implicit record genuinely is `Rec`
 * everywhere in the object, not just inside some nested scope.
 */
const DATAITEM_SCOPED_OBJECT_TYPES = new Set([
	"Report",
	"XMLport",
	"ReportExtension",
]);

const LOOP_NODE_TYPES = new Set([
	"repeat_statement",
	"for_statement",
	"foreach_statement",
	"while_statement",
]);

const LOOP_TYPE_MAP: Record<string, LoopInfo["type"]> = {
	repeat_statement: "repeat",
	for_statement: "for",
	foreach_statement: "foreach",
	while_statement: "while",
};

const NESTING_NODE_TYPES = new Set([
	"repeat_statement",
	"for_statement",
	"foreach_statement",
	"while_statement",
	"if_statement",
	"case_statement",
]);

/**
 * Check if the lines preceding a node contain an [EventSubscriber] attribute.
 * Looks up to 5 lines before the node's start row.
 */
function checkEventSubscriber(lines: string[], nodeStartRow: number): boolean {
	const start = Math.max(0, nodeStartRow - 5);
	for (let i = start; i < nodeStartRow; i++) {
		if (/\[EventSubscriber\b/i.test(lines[i])) {
			return true;
		}
	}
	return false;
}

/**
 * Parse [EventSubscriber] attribute to extract target details.
 * Format: [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", 'OnBeforePostSalesDoc', '', true, true)]
 */
function parseEventSubscriberAttribute(
	lines: string[],
	nodeStartRow: number,
): {
	targetObjectType: string;
	targetObjectId: string;
	targetEventName: string;
} | null {
	const start = Math.max(0, nodeStartRow - 5);
	for (let i = start; i < nodeStartRow; i++) {
		const match = lines[i].match(
			/\[EventSubscriber\(\s*ObjectType::(\w+)\s*,\s*(?:\w+)::"?([^"',)]+)"?\s*,\s*'([^']*)'/i,
		);
		if (match) {
			return {
				targetObjectType: match[1],
				targetObjectId: match[2],
				targetEventName: match[3],
			};
		}
	}
	return null;
}

/**
 * Check if the lines preceding a node contain an [IntegrationEvent] or [BusinessEvent] attribute.
 */
function checkEventPublisher(
	lines: string[],
	nodeStartRow: number,
): "IntegrationEvent" | "BusinessEvent" | null {
	const start = Math.max(0, nodeStartRow - 5);
	for (let i = start; i < nodeStartRow; i++) {
		if (/\[IntegrationEvent\b/i.test(lines[i])) return "IntegrationEvent";
		if (/\[BusinessEvent\b/i.test(lines[i])) return "BusinessEvent";
	}
	return null;
}

/**
 * Strip surrounding double quotes from a quoted_identifier node's text.
 */
function stripQuotes(text: string): string {
	if (text.startsWith('"') && text.endsWith('"')) {
		return text.slice(1, -1);
	}
	return text;
}

/**
 * V2 grammar helper: check if a node is a generic `property` with a specific name.
 * Many V1-specific property nodes (calc_formula_property, table_relation_property,
 * clustered_property) became generic `property` nodes in V2.
 */
function isPropertyNamed(node: SyntaxNode, name: string): boolean {
	return (
		node.type === "property" &&
		node.childForFieldName("name")?.text?.toLowerCase() === name.toLowerCase()
	);
}

/**
 * Find the object declaration node in the source file root.
 */
function findObjectDeclaration(root: SyntaxNode): SyntaxNode | null {
	for (const child of root.namedChildren) {
		if (child.type in OBJECT_TYPE_MAP) {
			return child;
		}
	}
	return null;
}

/**
 * Extract object ID from the declaration node.
 * The ID is the first integer child.
 */
function extractObjectId(decl: SyntaxNode): number {
	for (const child of decl.namedChildren) {
		if (child.type === "integer") {
			return parseInt(child.text, 10);
		}
	}
	return 0;
}

/**
 * Extract object name from the declaration node.
 * The name can be an identifier or quoted_identifier.
 */
function extractObjectName(decl: SyntaxNode): string {
	for (const child of decl.namedChildren) {
		if (child.type === "quoted_identifier") {
			return stripQuotes(child.text);
		}
		if (child.type === "identifier") {
			return child.text;
		}
	}
	return "";
}

/**
 * Extract procedure name from a procedure node.
 */
function extractProcedureName(proc: SyntaxNode): string {
	const nameNode = proc.childForFieldName("name");
	if (nameNode) {
		return nameNode.text;
	}
	return "";
}

/**
 * Extract trigger name from a trigger_declaration node.
 */
function extractTriggerName(trigger: SyntaxNode): string {
	const nameNode = trigger.childForFieldName("name");
	if (nameNode) {
		return stripQuotes(nameNode.text);
	}
	return "";
}

/**
 * Find the code_block child of a procedure or trigger node.
 */
function findCodeBlock(node: SyntaxNode): SyntaxNode | null {
	for (const child of node.namedChildren) {
		if (child.type === "code_block") {
			return child;
		}
	}
	return null;
}

/**
 * Recursively compute the maximum nesting depth of control flow in a node.
 */
function computeNestingDepth(node: SyntaxNode): number {
	let maxDepth = 0;

	for (const child of node.namedChildren) {
		if (NESTING_NODE_TYPES.has(child.type)) {
			const childDepth = 1 + computeNestingDepth(child);
			if (childDepth > maxDepth) {
				maxDepth = childDepth;
			}
		} else {
			const childDepth = computeNestingDepth(child);
			if (childDepth > maxDepth) {
				maxDepth = childDepth;
			}
		}
	}

	return maxDepth;
}

/**
 * Check if a node is a descendant of another node.
 */
function isDescendantOf(node: SyntaxNode, ancestor: SyntaxNode): boolean {
	let current = node.parent;
	while (current) {
		if (current.id === ancestor.id) return true;
		current = current.parent;
	}
	return false;
}

/**
 * Collect all loop nodes within a subtree.
 */
function collectLoopNodes(node: SyntaxNode): SyntaxNode[] {
	const loops: SyntaxNode[] = [];

	function walk(n: SyntaxNode) {
		if (LOOP_NODE_TYPES.has(n.type)) {
			loops.push(n);
		}
		for (const child of n.namedChildren) {
			walk(child);
		}
	}

	walk(node);
	return loops;
}

/**
 * Collect all record operation call_expression nodes within a subtree.
 * Returns [node, methodName, recordVariable, fieldArgument] tuples.
 *
 * `context` lets this recognize bare, receiver-less calls (`CalcFields(Amount);`)
 * as record ops on the implicit record -- idiomatic in Table/Page/Report/XMLport
 * code -- as opposed to a `member_expression` call on an explicit variable
 * (`SomeRec.CalcFields(...)`). Without `context` (or outside an object with an
 * implicit record), only `member_expression` calls are collected.
 */
function collectRecordOps(
	node: SyntaxNode,
	context?: ObjectContext,
): Array<{
	node: SyntaxNode;
	methodName: string;
	recordVariable: string;
	fieldArgument?: string;
	allFieldArguments?: string[];
}> {
	const ops: Array<{
		node: SyntaxNode;
		methodName: string;
		recordVariable: string;
		fieldArgument?: string;
		allFieldArguments?: string[];
	}> = [];

	// For Report/XMLport/ReportExtension the implicit record only exists
	// *inside* a dataitem/tableelement -- a bare call in one of these object
	// types with no enclosing dataitem (e.g. a report's global helper
	// procedure) has no implicit record at all and must not be collected
	// against a phantom "Rec" that doesn't exist there. Table/Page (and their
	// extensions) have no dataitem wrapper, so this extra guard doesn't apply
	// to them -- their implicit record genuinely is `Rec` everywhere.
	const hasImplicitRecord =
		!!context &&
		IMPLICIT_RECORD_OBJECT_TYPES.has(context.objectType) &&
		(!DATAITEM_SCOPED_OBJECT_TYPES.has(context.objectType) ||
			!!context.dataitemName);
	// The implicit record's own name: a Report/XMLport dataitem's instance name
	// (e.g. "CustLedgerEntry") when the bare call sits inside that dataitem --
	// reports/XMLports have no variable literally named `Rec`. A Table/Page has
	// no dataitem wrapper, so its implicit record genuinely is `Rec`.
	const implicitRecordVariable = context?.dataitemName ?? "Rec";

	function extractFieldArgument(
		callNode: SyntaxNode,
		methodName: string,
	): string | undefined {
		const lowerMethod = methodName.toLowerCase();
		if (lowerMethod !== "setrange" && lowerMethod !== "setfilter")
			return undefined;
		const argList = callNode.namedChildren.find(
			(c) => c.type === "argument_list",
		);
		if (argList && argList.namedChildren.length > 0) {
			const firstArg = argList.namedChildren[0];
			return stripQuotes(firstArg.text);
		}
		return undefined;
	}

	function extractAllFieldArguments(
		callNode: SyntaxNode,
		methodName: string,
	): string[] | undefined {
		if (methodName.toLowerCase() !== "setloadfields") return undefined;
		const argList = callNode.namedChildren.find(
			(c) => c.type === "argument_list",
		);
		if (argList) {
			const args: string[] = [];
			for (const arg of argList.namedChildren) {
				args.push(stripQuotes(arg.text));
			}
			return args;
		}
		return undefined;
	}

	function walk(n: SyntaxNode) {
		if (n.type === "call_expression") {
			const funcNode = n.childForFieldName("function") ?? n.namedChildren[0];
			if (funcNode) {
				if (funcNode.type === "member_expression") {
					const objNode =
						funcNode.childForFieldName("object") ?? funcNode.namedChildren[0];
					const propNode =
						funcNode.childForFieldName("member") ?? funcNode.namedChildren[1];
					if (propNode) {
						const methodName = stripQuotes(propNode.text);
						if (RECORD_OPS.has(methodName.toLowerCase())) {
							ops.push({
								node: n,
								methodName,
								recordVariable: objNode ? objNode.text : "",
								fieldArgument: extractFieldArgument(n, methodName),
								allFieldArguments: extractAllFieldArguments(n, methodName),
							});
						}
					}
				} else if (
					hasImplicitRecord &&
					(funcNode.type === "identifier" ||
						funcNode.type === "quoted_identifier")
				) {
					// A plain-identifier call with no receiver -- `CalcFields(Amount);`,
					// `FindSet();`, `Modify();` -- is a record op on the implicit record
					// here, gated on the enclosing object actually having one (see
					// IMPLICIT_RECORD_OBJECT_TYPES).
					//
					// Residual false positive, accepted and documented rather than
					// dropping every implicit-record call in every table, page, report
					// and XMLport: a *local procedure* named `Get` or `Count` inside one
					// of these objects now also reads as a record op. That is rare, and
					// a far smaller error than the silent blind spot this branch fixes.
					const methodName = stripQuotes(funcNode.text);
					if (RECORD_OPS.has(methodName.toLowerCase())) {
						ops.push({
							node: n,
							methodName,
							recordVariable: implicitRecordVariable,
							fieldArgument: extractFieldArgument(n, methodName),
							allFieldArguments: extractAllFieldArguments(n, methodName),
						});
					}
				}
			}
		}

		for (const child of n.namedChildren) {
			walk(child);
		}
	}

	walk(node);
	return ops;
}

const DANGEROUS_CALLS = new Set(["commit", "error", "testfield"]);

const DANGEROUS_CALL_CASE_MAP: Record<string, DangerousCallInfo["type"]> = {
	commit: "Commit",
	error: "Error",
	testfield: "TestField",
};

/**
 * Collect dangerous call_expression nodes (Commit, Error, TestField) within a subtree.
 */
function collectDangerousCalls(
	node: SyntaxNode,
): Array<{ node: SyntaxNode; callType: DangerousCallInfo["type"] }> {
	const calls: Array<{
		node: SyntaxNode;
		callType: DangerousCallInfo["type"];
	}> = [];

	function walk(n: SyntaxNode) {
		if (n.type === "call_expression") {
			const funcNode = n.childForFieldName("function") ?? n.namedChildren[0];
			if (funcNode) {
				const name = funcNode.text.toLowerCase();
				if (DANGEROUS_CALLS.has(name)) {
					calls.push({ node: n, callType: DANGEROUS_CALL_CASE_MAP[name] });
				}
			}
		}
		for (const child of n.namedChildren) {
			walk(child);
		}
	}

	walk(node);
	return calls;
}

/**
 * The declared type name (as it appears in a `var` section, lowercased) that
 * marks a variable as an HTTP client. `HttpClient.{Send,Get,Post,Put,Patch,
 * Delete}` are recognized by this declared type, NOT by method name alone --
 * `Get`/`Delete` collide with `RECORD_OPS`' method names, so a plain
 * `Record`-typed variable's `Get()`/`Delete()` must never match here.
 */
const HTTPCLIENT_TYPE_NAME = "httpclient";

/** HttpClient method name (lowercase) -> ExternalCallInfo type. */
const EXTERNAL_HTTP_CALL_CASE_MAP: Record<string, ExternalCallInfo["type"]> = {
	send: "HttpClient.Send",
	get: "HttpClient.Get",
	post: "HttpClient.Post",
	put: "HttpClient.Put",
	patch: "HttpClient.Patch",
	delete: "HttpClient.Delete",
};

/**
 * Build a lookup from variable name (lowercase) to declared type string
 * (lowercase, trimmed) for the variables in scope of the procedure/trigger
 * currently being walked. Used to gate `HttpClient` member calls by the
 * receiver's actual declared type rather than by method name alone.
 */
function buildVariableTypeMap(
	variables: VariableInfo[] | undefined,
): Map<string, string> {
	const map = new Map<string, string>();
	if (!variables) return map;
	for (const v of variables) {
		map.set(v.name.toLowerCase(), v.typeStr.trim().toLowerCase());
	}
	return map;
}

/**
 * Collect external-call_expression nodes within a subtree: `HttpClient.
 * {Send,Get,Post,Put,Patch,Delete}` (gated on the receiver's declared type
 * via `variableTypes`) and bare `Sleep(...)` (a global BC procedure, no
 * receiver, no type resolution needed -- and no collision with `RECORD_OPS`,
 * since "sleep" isn't one of them).
 */
function collectExternalCalls(
	node: SyntaxNode,
	variableTypes: Map<string, string>,
): Array<{ node: SyntaxNode; callType: ExternalCallInfo["type"] }> {
	const calls: Array<{ node: SyntaxNode; callType: ExternalCallInfo["type"] }> =
		[];

	function walk(n: SyntaxNode) {
		if (n.type === "call_expression") {
			const funcNode = n.childForFieldName("function") ?? n.namedChildren[0];
			if (funcNode) {
				if (funcNode.type === "member_expression") {
					const objNode =
						funcNode.childForFieldName("object") ?? funcNode.namedChildren[0];
					const propNode =
						funcNode.childForFieldName("member") ?? funcNode.namedChildren[1];
					if (objNode && propNode) {
						const methodName = stripQuotes(propNode.text).toLowerCase();
						const declaredType = variableTypes.get(objNode.text.toLowerCase());
						if (
							declaredType === HTTPCLIENT_TYPE_NAME &&
							methodName in EXTERNAL_HTTP_CALL_CASE_MAP
						) {
							calls.push({
								node: n,
								callType: EXTERNAL_HTTP_CALL_CASE_MAP[methodName],
							});
						}
					}
				} else if (
					funcNode.type === "identifier" ||
					funcNode.type === "quoted_identifier"
				) {
					const name = stripQuotes(funcNode.text).toLowerCase();
					if (name === "sleep") {
						calls.push({ node: n, callType: "Sleep" });
					}
				}
			}
		}
		for (const child of n.namedChildren) {
			walk(child);
		}
	}

	walk(node);
	return calls;
}

/**
 * Promote items not already inside a syntactic loop into `insideLoop` when
 * the enclosing member is a per-row trigger (Task 7 — Report/XMLport/Page
 * `OnAfterGetRecord`). Mutates each promoted item in place and appends it to
 * `inLoopList`. Shared across `recordOps`, `dangerousCalls`, and
 * `externalCalls` -- all three carry the identical `{ insideLoop,
 * implicitLoop }` shape and need the identical promotion + self-explanation.
 */
function promoteImplicitLoopItems<T extends ImplicitLoopAware>(
	items: T[],
	inLoopList: T[],
	implicitLoop: string,
): void {
	for (const item of items) {
		if (!item.insideLoop) {
			item.insideLoop = true;
			item.implicitLoop = implicitLoop;
			inLoopList.push(item);
		}
	}
}

/**
 * Collect field access nodes: Rec.Field or Rec."Field Name" (member_expression not in call).
 */
function collectFieldAccesses(node: SyntaxNode): FieldAccessInfo[] {
	const accesses: FieldAccessInfo[] = [];

	function walk(n: SyntaxNode) {
		if (
			n.type === "member_expression" &&
			n.parent?.type !== "call_expression"
		) {
			// Rec.Field style, but NOT when it's the function part of a call
			const objNode = n.childForFieldName("object") ?? n.namedChildren[0];
			const propNode = n.childForFieldName("member") ?? n.namedChildren[1];
			if (objNode && propNode) {
				accesses.push({
					recordVariable: objNode.text,
					fieldName: stripQuotes(propNode.text),
					line: n.startPosition.row + 1,
					column: n.startPosition.column,
				});
			}
		}

		for (const child of n.namedChildren) {
			walk(child);
		}
	}

	walk(node);
	return accesses;
}

/**
 * Extract variable declarations from a procedure/trigger node's var_section.
 */
function extractVariables(procedureNode: SyntaxNode): VariableInfo[] {
	const variables: VariableInfo[] = [];

	for (const child of procedureNode.namedChildren) {
		if (child.type !== "var_section") continue;

		// tree-sitter-al v3: variable declarations are nested under a `var_body`
		// node (body field) rather than being direct children of var_section.
		// Fall back to var_section itself for older grammars / empty sections.
		const varBody = child.namedChildren.find((c) => c.type === "var_body");
		const declContainer = varBody ?? child;
		for (const varDecl of declContainer.namedChildren) {
			if (varDecl.type !== "variable_declaration") continue;

			const nameNode = varDecl.namedChildren.find(
				(c) => c.type === "identifier",
			);
			const typeSpecNode = varDecl.namedChildren.find(
				(c) => c.type === "type_specification",
			);

			if (!nameNode || !typeSpecNode) continue;

			const name = nameNode.text;
			const typeStr = typeSpecNode.text;

			// Check if Record type
			const recordTypeNode = typeSpecNode.namedChildren.find(
				(c) => c.type === "record_type",
			);
			const isTemporary =
				recordTypeNode?.namedChildren.some(
					(c) => c.type === "temporary_keyword",
				) ?? false;
			const isRecord = recordTypeNode !== undefined;

			let tableName: string | undefined;
			if (isRecord && recordTypeNode) {
				const quotedId = recordTypeNode.namedChildren.find(
					(c) => c.type === "quoted_identifier",
				);
				if (quotedId) {
					tableName = stripQuotes(quotedId.text);
				} else {
					const id = recordTypeNode.namedChildren.find(
						(c) => c.type === "identifier",
					);
					if (id) tableName = id.text;
				}
			}

			variables.push({
				name,
				typeStr,
				isRecord,
				tableName,
				isTemporary,
				line: varDecl.startPosition.row + 1,
			});
		}
	}

	return variables;
}

/**
 * Triggers the BC platform calls ONCE PER ROW. Their whole body is a loop body,
 * even though nothing in the AL source is syntactically a loop.
 *
 * This is the most common place a real BC performance bug lives — a CalcFields in
 * a report's OnAfterGetRecord is one SQL aggregation per row of the dataitem — and
 * before this, none of the source-correlated detectors could see any of it.
 *
 * OnPreDataItem / OnPostDataItem run once and are deliberately NOT here. Table
 * triggers (OnValidate/OnInsert/OnModify) are deliberately NOT here either —
 * they are per-*operation*, not per-row; they are only a loop when the caller
 * loops, which needs cross-procedure call-graph propagation, not this.
 *
 * `ReportExtension`/`PageExtension` are included alongside their base types:
 * a reportextension can add a dataitem (`addfirst`/`addlast` in its
 * `dataset`), and a pageextension can override `OnAfterGetRecord` directly —
 * both are real BC extensibility idioms, and since base reports/pages can't
 * be modified in place, this is where most real ISV code doing this lives.
 * `TableExtension` has no per-row trigger (tables have no dataitem/rendering
 * concept) and is deliberately absent here.
 *
 * Keys are `objectType` strings exactly as produced by `OBJECT_TYPE_MAP` —
 * note `"XMLport"`, not `"XmlPort"` or `"Xmlport"`.
 */
const PER_ROW_TRIGGERS: Record<string, Set<string>> = {
	Report: new Set(["onaftergetrecord"]),
	XMLport: new Set(["onaftergetrecord"]),
	Page: new Set(["onaftergetrecord"]),
	ReportExtension: new Set(["onaftergetrecord"]),
	PageExtension: new Set(["onaftergetrecord"]),
};

function isPerRowTrigger(objectType: string, triggerName: string): boolean {
	return PER_ROW_TRIGGERS[objectType]?.has(triggerName.toLowerCase()) ?? false;
}

/**
 * Context an object member (procedure or trigger) is declared in. Threaded
 * into `extractFeatures` so it can reason about things the code_block alone
 * can't tell it — e.g. whether this member is a per-row trigger. Deliberately
 * carries the object type (not just a boolean) so later features can key off
 * it too (e.g. whether the object has an implicit `Rec`).
 */
interface ObjectContext {
	/** Matches `OBJECT_TYPE_MAP`'s values exactly, e.g. "Report", "XMLport". */
	objectType: string;
	/** The trigger name, e.g. "OnAfterGetRecord". Undefined for procedures. */
	triggerName?: string;
	/**
	 * Name of the nearest enclosing Report `dataitem` or XMLport `tableelement`
	 * instance (e.g. `"CustLedgerEntry"` in `dataitem(CustLedgerEntry; "Cust.
	 * Ledger Entry")`). Undefined outside a dataitem/tableelement — which
	 * includes Table and Page, where the implicit record genuinely is `Rec`,
	 * not a dataitem name.
	 */
	dataitemName?: string;
	/**
	 * This member's own `var`-section declarations, extracted by the caller
	 * *before* calling `extractFeatures` (order matters — see call sites in
	 * `walkForMembers`). Threaded in so `collectExternalCalls` can resolve a
	 * receiver variable's declared type (e.g. distinguishing an `HttpClient`
	 * variable's `.Get()` from a `Record`-typed variable's `.Get()`).
	 */
	variables?: VariableInfo[];
}

/**
 * Extract structural features (loops, record ops, nesting) from a code_block node.
 */
function extractFeatures(
	codeBlock: SyntaxNode | null,
	context?: ObjectContext,
): ProcedureFeatures {
	if (!codeBlock) {
		return {
			loops: [],
			recordOps: [],
			recordOpsInLoops: [],
			dangerousCallsInLoops: [],
			externalCallsInLoops: [],
			variables: [],
			fieldAccesses: [],
			nestingDepth: 0,
		};
	}

	// Collect loops
	const loopNodes = collectLoopNodes(codeBlock);
	const loops: LoopInfo[] = loopNodes.map((ln) => ({
		type: LOOP_TYPE_MAP[ln.type],
		lineStart: ln.startPosition.row + 1, // Convert 0-based to 1-based
		lineEnd: ln.endPosition.row + 1,
	}));

	// Collect record ops
	const rawOps = collectRecordOps(codeBlock, context);
	const recordOps: RecordOpInfo[] = [];
	const recordOpsInLoops: RecordOpInfo[] = [];

	for (const op of rawOps) {
		const insideLoop = loopNodes.some((ln) => isDescendantOf(op.node, ln));
		const opInfo: RecordOpInfo = {
			type: RECORD_OP_CASE_MAP[op.methodName.toLowerCase()],
			line: op.node.startPosition.row + 1,
			column: op.node.startPosition.column,
			insideLoop,
			recordVariable: op.recordVariable || undefined,
			fieldArgument: op.fieldArgument,
			allFieldArguments: op.allFieldArguments,
		};
		recordOps.push(opInfo);
		if (insideLoop) {
			recordOpsInLoops.push(opInfo);
		}
	}

	// Collect dangerous calls (Commit, Error, TestField)
	const rawDangerousCalls = collectDangerousCalls(codeBlock);
	const dangerousCalls: DangerousCallInfo[] = [];
	const dangerousCallsInLoops: DangerousCallInfo[] = [];
	for (const dc of rawDangerousCalls) {
		const insideLoop = loopNodes.some((ln) => isDescendantOf(dc.node, ln));
		const dcInfo: DangerousCallInfo = {
			type: dc.callType,
			line: dc.node.startPosition.row + 1,
			column: dc.node.startPosition.column,
			insideLoop,
		};
		dangerousCalls.push(dcInfo);
		if (insideLoop) {
			dangerousCallsInLoops.push(dcInfo);
		}
	}

	// Collect external calls (HttpClient.{Send,Get,Post,Put,Patch,Delete}, Sleep)
	const variableTypes = buildVariableTypeMap(context?.variables);
	const rawExternalCalls = collectExternalCalls(codeBlock, variableTypes);
	const externalCalls: ExternalCallInfo[] = [];
	const externalCallsInLoops: ExternalCallInfo[] = [];
	for (const ec of rawExternalCalls) {
		const insideLoop = loopNodes.some((ln) => isDescendantOf(ec.node, ln));
		const ecInfo: ExternalCallInfo = {
			type: ec.callType,
			line: ec.node.startPosition.row + 1,
			column: ec.node.startPosition.column,
			insideLoop,
		};
		externalCalls.push(ecInfo);
		if (insideLoop) {
			externalCallsInLoops.push(ecInfo);
		}
	}

	// Per-row triggers (Report/XMLport/Page OnAfterGetRecord): the platform
	// calls this trigger once per row, so its whole body is a loop body even
	// though nothing here is syntactically a loop. Promote every op/call that
	// isn't already inside a real loop, and tag it so findings can explain
	// themselves — "inside a loop" with no visible loop reads as a tool bug.
	if (
		context?.triggerName &&
		isPerRowTrigger(context.objectType, context.triggerName)
	) {
		const implicitLoop = `${context.objectType}.${context.triggerName}`;
		promoteImplicitLoopItems(recordOps, recordOpsInLoops, implicitLoop);
		promoteImplicitLoopItems(
			dangerousCalls,
			dangerousCallsInLoops,
			implicitLoop,
		);
		promoteImplicitLoopItems(externalCalls, externalCallsInLoops, implicitLoop);
	}

	// Collect field accesses
	const fieldAccesses = collectFieldAccesses(codeBlock);

	// Compute nesting depth
	const nestingDepth = computeNestingDepth(codeBlock);

	return {
		loops,
		recordOps,
		recordOpsInLoops,
		dangerousCallsInLoops,
		externalCallsInLoops,
		variables: [],
		fieldAccesses,
		nestingDepth,
	};
}

/** Map from aggregate function name (lowercase) to CalcFormulaType.
 * Lookup is excluded — it has its own `lookup_formula` node type in V2. */
const CALC_FORMULA_FUNC_MAP: Record<string, TableFieldInfo["calcFormulaType"]> =
	{
		sum: "Sum",
		count: "Count",
		average: "Average",
		min: "Min",
		max: "Max",
		exist: "Exist",
	};

/**
 * Recursively search a TableRelation value subtree for the first simple_table_relation
 * and extract the target table name from it.
 */
function findTableRelationTarget(node: SyntaxNode): string | undefined {
	if (node.type === "simple_table_relation") {
		const ref = node.namedChildren.find(
			(c) => c.type === "identifier" || c.type === "quoted_identifier",
		);
		return ref ? stripQuotes(ref.text) : undefined;
	}
	for (const child of node.namedChildren) {
		const found = findTableRelationTarget(child);
		if (found) return found;
	}
	return undefined;
}

/**
 * tree-sitter-al v3 nests a declaration's inner `{ ... }` content under a
 * `declaration_body` node (body field) instead of as direct children. This
 * returns a declaration's direct named children plus its body's children, so
 * property lookups (CalcFormula, Clustered, …) work across v2 and v3 grammars.
 */
function declarationChildren(node: SyntaxNode): SyntaxNode[] {
	const body = node.namedChildren.find((c) => c.type === "declaration_body");
	return body
		? [...node.namedChildren, ...body.namedChildren]
		: node.namedChildren;
}

/**
 * Extract table field declarations from a table declaration node.
 */
function extractTableFields(declNode: SyntaxNode): TableFieldInfo[] {
	const fields: TableFieldInfo[] = [];

	function walk(node: SyntaxNode) {
		if (node.type === "field_declaration") {
			let id = 0;
			let name = "";
			let dataType = "";
			let calcFormulaType: TableFieldInfo["calcFormulaType"] | undefined;
			let calcFormulaTable: string | undefined;
			let tableRelationTarget: string | undefined;

			for (const child of declarationChildren(node)) {
				if (child.type === "integer" && id === 0) {
					id = parseInt(child.text, 10);
				} else if (child.type === "quoted_identifier" && !name) {
					name = stripQuotes(child.text);
				} else if (child.type === "type_specification") {
					dataType = child.text;
				} else if (isPropertyNamed(child, "CalcFormula")) {
					const value = child.childForFieldName("value");
					if (value) {
						// In V2, the value field IS the formula node directly (aggregate_formula or lookup_formula)
						const formulaNode =
							value.type === "aggregate_formula" ||
							value.type === "lookup_formula"
								? value
								: value.namedChildren.find(
										(c) =>
											c.type === "aggregate_formula" ||
											c.type === "lookup_formula",
									);
						if (formulaNode?.type === "aggregate_formula") {
							const funcNode = formulaNode.namedChildren.find(
								(c) => c.type === "aggregate_function",
							);
							const funcName = funcNode?.text?.toLowerCase();
							if (funcName && funcName in CALC_FORMULA_FUNC_MAP) {
								calcFormulaType = CALC_FORMULA_FUNC_MAP[funcName];
							}
							for (const refChild of formulaNode.namedChildren) {
								if (refChild.type === "calc_field_reference") {
									const tableNode = refChild.namedChildren.find(
										(c) =>
											c.type === "identifier" || c.type === "quoted_identifier",
									);
									if (tableNode) {
										calcFormulaTable = stripQuotes(tableNode.text);
									}
								}
							}
						} else if (formulaNode?.type === "lookup_formula") {
							calcFormulaType = "Lookup";
							for (const refChild of formulaNode.namedChildren) {
								if (refChild.type === "calc_field_reference") {
									const tableNode = refChild.namedChildren.find(
										(c) =>
											c.type === "identifier" || c.type === "quoted_identifier",
									);
									if (tableNode) {
										calcFormulaTable = stripQuotes(tableNode.text);
									}
								} else if (refChild.type === "member_expression") {
									const obj =
										refChild.childForFieldName("object") ??
										refChild.namedChildren[0];
									if (obj) {
										calcFormulaTable = stripQuotes(obj.text);
									}
								}
							}
						}
					}
				} else if (isPropertyNamed(child, "TableRelation")) {
					const value = child.childForFieldName("value");
					if (value) {
						tableRelationTarget = findTableRelationTarget(value);
					}
				}
			}

			if (name) {
				fields.push({
					id,
					name,
					dataType,
					calcFormulaType,
					calcFormulaTable,
					tableRelationTarget,
					line: node.startPosition.row + 1,
				});
			}
			return; // Don't recurse into field_declaration children
		}

		for (const child of node.namedChildren) {
			walk(child);
		}
	}

	walk(declNode);
	return fields;
}

/**
 * Extract key declarations from a table declaration node.
 */
function extractTableKeys(declNode: SyntaxNode): TableKeyInfo[] {
	const keys: TableKeyInfo[] = [];

	function walk(node: SyntaxNode) {
		if (node.type === "key_declaration") {
			const name = node.childForFieldName("name")?.text ?? "";
			const keyFieldList = node.namedChildren.find(
				(c) => c.type === "field_list",
			);
			const fields: string[] = [];
			if (keyFieldList) {
				for (const child of keyFieldList.namedChildren) {
					if (child.type === "quoted_identifier") {
						fields.push(stripQuotes(child.text));
					} else if (child.type === "identifier") {
						fields.push(child.text);
					}
				}
			}

			let clustered = false;
			for (const child of declarationChildren(node)) {
				if (isPropertyNamed(child, "Clustered")) {
					const value = child.childForFieldName("value")?.text;
					clustered = value?.toLowerCase() === "true";
					break;
				}
			}

			if (name) {
				keys.push({
					name,
					fields,
					clustered,
					line: node.startPosition.row + 1,
				});
			}
			return;
		}

		for (const child of node.namedChildren) {
			walk(child);
		}
	}

	walk(declNode);
	return keys;
}

/**
 * If `node` is a Report dataitem or an XMLport tableelement, return its
 * instance name (e.g. `"CustLedgerEntry"` in `dataitem(CustLedgerEntry; "Cust.
 * Ledger Entry")`); otherwise undefined.
 *
 * A Report dataitem is its own node type, `report_dataitem`. An XMLport
 * tableelement shares its node type, `xmlport_element`, with textelement and
 * fieldelement -- those have no table binding (just a name, no
 * `quoted_identifier` child), so only treat an `xmlport_element` as
 * record-bearing when a table reference is actually present.
 */
function findDataitemName(node: SyntaxNode): string | undefined {
	if (node.type === "report_dataitem") {
		return node.namedChildren.find((c) => c.type === "identifier")?.text;
	}
	if (
		node.type === "xmlport_element" &&
		node.namedChildren.some((c) => c.type === "quoted_identifier")
	) {
		return node.namedChildren.find((c) => c.type === "identifier")?.text;
	}
	return undefined;
}

/**
 * Parse a single AL file and return its ObjectInfo.
 */
export async function indexALFile(
	absolutePath: string,
	baseDir: string,
): Promise<ObjectInfo | null> {
	let source: string;
	try {
		source = readFileSync(absolutePath, "utf-8");
	} catch {
		return null;
	}

	const sourceLines = source.split("\n");
	const tree = await parseALSource(source);
	const root = tree.rootNode;

	const declNode = findObjectDeclaration(root);
	if (!declNode) {
		return null;
	}

	const objectType = OBJECT_TYPE_MAP[declNode.type];
	const objectId = extractObjectId(declNode);
	const objectName = extractObjectName(declNode);
	const relativePath = relative(baseDir, absolutePath).replace(/\\/g, "/");

	const fileInfo: ALFileInfo = {
		relativePath,
		absolutePath,
		objectType,
		objectName,
		objectId,
	};

	const procedures: ProcedureInfo[] = [];
	const triggers: TriggerInfo[] = [];

	// Walk children of the declaration node to find procedures and triggers.
	// `dataitemName` is the nearest enclosing Report dataitem / XMLport
	// tableelement instance name, threaded down so triggers nested inside one
	// (e.g. a dataitem's OnAfterGetRecord) know their implicit record is that
	// dataitem, not `Rec`. Updated only when descending into a node that is
	// itself one; preserved for every other container node in between
	// (report_body, xmlport_body, declaration_body, ...).
	function walkForMembers(node: SyntaxNode, dataitemName?: string) {
		for (const child of node.namedChildren) {
			if (child.type === "procedure") {
				const name = extractProcedureName(child);
				const codeBlock = findCodeBlock(child);
				// Variables must be extracted BEFORE extractFeatures — it needs
				// them (via context.variables) to resolve a receiver variable's
				// declared type for external-call detection (e.g. HttpClient).
				const variables = extractVariables(child);
				const features = extractFeatures(codeBlock, {
					objectType,
					dataitemName,
					variables,
				});
				features.variables = variables;

				procedures.push({
					name,
					objectType,
					objectName,
					objectId,
					file: relativePath,
					lineStart: child.startPosition.row + 1,
					lineEnd: child.endPosition.row + 1,
					features,
					isEventSubscriber: checkEventSubscriber(
						sourceLines,
						child.startPosition.row,
					),
				});
			} else if (child.type === "trigger_declaration") {
				const name = extractTriggerName(child);
				const codeBlock = findCodeBlock(child);
				const variables = extractVariables(child);
				const features = extractFeatures(codeBlock, {
					objectType,
					triggerName: name,
					dataitemName,
					variables,
				});
				features.variables = variables;

				triggers.push({
					name,
					objectType,
					objectName,
					objectId,
					file: relativePath,
					lineStart: child.startPosition.row + 1,
					lineEnd: child.endPosition.row + 1,
					features,
				});
			} else {
				// Recurse into other container nodes (e.g., fields, keys, dataitems, etc.)
				walkForMembers(child, findDataitemName(child) ?? dataitemName);
			}
		}
	}

	walkForMembers(declNode);

	// Extract table fields (only for table/tableextension declarations)
	const fields =
		objectType === "Table" || objectType === "TableExtension"
			? extractTableFields(declNode)
			: [];

	// Extract table keys (only for table/tableextension declarations)
	const keys =
		objectType === "Table" || objectType === "TableExtension"
			? extractTableKeys(declNode)
			: [];

	return {
		objectType,
		objectName,
		objectId,
		file: fileInfo,
		procedures,
		triggers,
		fields,
		keys,
	};
}

/**
 * Recursively find all .al files in a directory.
 */
async function findALFiles(dirPath: string): Promise<string[]> {
	const { Glob } = await import("bun");
	const glob = new Glob("**/*.al");
	const files: string[] = [];
	for await (const file of glob.scan({ cwd: dirPath, absolute: true })) {
		files.push(file);
	}
	return files;
}

/**
 * Build a source index from a directory of AL files.
 */
export async function buildSourceIndex(dirPath: string): Promise<SourceIndex> {
	const alFiles = await findALFiles(dirPath);

	const index: SourceIndex = {
		files: [],
		procedures: new Map(),
		triggers: new Map(),
		objects: new Map(),
		eventCatalog: { publishers: [], subscribers: [] },
	};

	for (const filePath of alFiles) {
		const objectInfo = await indexALFile(filePath, dirPath);
		if (!objectInfo) continue;

		index.files.push(objectInfo.file);

		const objectKey = `${objectInfo.objectType}_${objectInfo.objectId}`;
		index.objects.set(objectKey, objectInfo);

		for (const proc of objectInfo.procedures) {
			const key = proc.name.toLowerCase();
			const existing = index.procedures.get(key) ?? [];
			existing.push(proc);
			index.procedures.set(key, existing);
		}

		for (const trigger of objectInfo.triggers) {
			const key = trigger.name.toLowerCase();
			const existing = index.triggers.get(key) ?? [];
			existing.push(trigger);
			index.triggers.set(key, existing);
		}
	}

	// Build event catalog from indexed procedures
	for (const obj of index.objects.values()) {
		const filePath = obj.file.absolutePath;
		let fileLines: string[] | null = null;
		const getLines = () => {
			if (!fileLines) {
				try {
					fileLines = readFileSync(filePath, "utf-8").split("\n");
				} catch {
					fileLines = [];
				}
			}
			return fileLines;
		};

		for (const proc of obj.procedures) {
			const lines = getLines();
			// Check for event subscriber
			if (proc.isEventSubscriber) {
				const subInfo = parseEventSubscriberAttribute(
					lines,
					proc.lineStart - 1,
				);
				if (subInfo) {
					index.eventCatalog.subscribers.push({
						procedureName: proc.name,
						targetObjectType: subInfo.targetObjectType,
						targetObjectId: subInfo.targetObjectId,
						targetEventName: subInfo.targetEventName,
						objectType: obj.objectType,
						objectId: obj.objectId,
						objectName: obj.objectName,
						file: proc.file,
						line: proc.lineStart,
					});
				}
			}

			// Check for event publisher
			const pubType = checkEventPublisher(lines, proc.lineStart - 1);
			if (pubType) {
				index.eventCatalog.publishers.push({
					procedureName: proc.name,
					eventType: pubType,
					objectType: obj.objectType,
					objectId: obj.objectId,
					objectName: obj.objectName,
					file: proc.file,
					line: proc.lineStart,
				});
			}
		}
	}

	return index;
}
