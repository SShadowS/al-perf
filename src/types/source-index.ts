export interface SourceIndex {
	/** All indexed AL files */
	files: ALFileInfo[];

	/** All procedures, keyed by name (lowercase) for lookup */
	procedures: Map<string, ProcedureInfo[]>;

	/** All triggers, keyed by name (lowercase) for lookup */
	triggers: Map<string, TriggerInfo[]>;

	/** Object info, keyed by "ObjectType_ObjectId" */
	objects: Map<string, ObjectInfo>;

	/** Event publisher/subscriber catalog built from source attributes */
	eventCatalog: EventCatalog;
}

export interface EventPublisherInfo {
	procedureName: string;
	eventType: "IntegrationEvent" | "BusinessEvent";
	objectType: string;
	objectId: number;
	objectName: string;
	file: string;
	line: number;
}

export interface EventSubscriberInfo {
	procedureName: string;
	/** Target object type the subscriber listens to */
	targetObjectType: string;
	/** Target object ID or name */
	targetObjectId: string;
	/** Target event name */
	targetEventName: string;
	objectType: string;
	objectId: number;
	objectName: string;
	file: string;
	line: number;
}

export interface EventCatalog {
	publishers: EventPublisherInfo[];
	subscribers: EventSubscriberInfo[];
}

export interface ALFileInfo {
	/** Relative path to the .al file */
	relativePath: string;

	/** Absolute path to the .al file */
	absolutePath: string;

	/** The object declared in this file */
	objectType: string;
	objectName: string;
	objectId: number;
}

export interface ObjectInfo {
	objectType: string;
	objectName: string;
	objectId: number;
	file: ALFileInfo;
	procedures: ProcedureInfo[];
	triggers: TriggerInfo[];
	fields: TableFieldInfo[];
	keys: TableKeyInfo[];
}

export interface TableFieldInfo {
	id: number;
	name: string;
	dataType: string;
	calcFormulaType?:
		| "Sum"
		| "Lookup"
		| "Count"
		| "Average"
		| "Min"
		| "Max"
		| "Exist";
	calcFormulaTable?: string;
	/** Table referenced in TableRelation property */
	tableRelationTarget?: string;
	line: number;
}

export interface TableRelationInfo {
	/** Source table that has the relation */
	fromTable: string;
	fromTableId: number;
	/** Field in the source table */
	fromField: string;
	/** Target table referenced */
	toTable: string;
	/** Type of relationship */
	relationType: "TableRelation" | "CalcFormula";
	line: number;
}

export interface TableKeyInfo {
	name: string;
	fields: string[];
	clustered: boolean;
	line: number;
}

export interface ProcedureInfo {
	name: string;
	objectType: string;
	objectName: string;
	objectId: number;
	file: string;
	lineStart: number;
	lineEnd: number;
	features: ProcedureFeatures;
	isEventSubscriber: boolean;
}

export interface TriggerInfo {
	name: string;
	objectType: string;
	objectName: string;
	objectId: number;
	file: string;
	lineStart: number;
	lineEnd: number;
	features: ProcedureFeatures;
}

export interface ProcedureFeatures {
	loops: LoopInfo[];
	recordOps: RecordOpInfo[];
	recordOpsInLoops: RecordOpInfo[];
	dangerousCallsInLoops: DangerousCallInfo[];
	externalCallsInLoops: ExternalCallInfo[];
	variables: VariableInfo[];
	fieldAccesses: FieldAccessInfo[];
	nestingDepth: number;
}

export interface FieldAccessInfo {
	/** The record variable name (e.g., "SalesLine") */
	recordVariable: string;
	/** The field name (e.g., "Amount", "Document No.") */
	fieldName: string;
	line: number;
	column: number;
}

export interface VariableInfo {
	name: string;
	/** Full type string, e.g. "Record \"Sales Line\"", "Integer", "Text[100]" */
	typeStr: string;
	/** True if this is a Record type */
	isRecord: boolean;
	/** Table name if Record type, e.g. "Sales Line" */
	tableName?: string;
	/** True if declared with 'temporary' keyword */
	isTemporary: boolean;
	line: number;
}

export interface DangerousCallInfo {
	type: "Commit" | "Error" | "TestField";
	line: number;
	column: number;
	insideLoop: boolean;
	/**
	 * Same meaning as `RecordOpInfo.implicitLoop`: set when `insideLoop` is
	 * true because this call sits in a per-row trigger (Report/XMLport/Page
	 * `OnAfterGetRecord`) rather than a syntactic loop. A `Commit()` in a
	 * report's `OnAfterGetRecord` is commit-per-row — one of the worst BC
	 * performance bugs there is — and a finding that just says "inside a
	 * loop" against a trigger with no visible loop reads as a tool bug.
	 */
	implicitLoop?: string;
}

/**
 * `HttpClient.{Send,Get,Post,Put,Patch,Delete}` calls (recognized by the
 * receiver variable's declared type, since `Get`/`Delete` collide with
 * record-op method names) and bare `Sleep(...)` calls. A completely
 * different bug shape from `DangerousCallInfo`'s Commit/Error/TestField:
 * those are transactional problems, this is a latency problem -- one
 * network round-trip (or blocking delay) per iteration.
 */
export interface ExternalCallInfo {
	type:
		| "HttpClient.Send"
		| "HttpClient.Get"
		| "HttpClient.Post"
		| "HttpClient.Put"
		| "HttpClient.Patch"
		| "HttpClient.Delete"
		| "Sleep";
	line: number;
	column: number;
	insideLoop: boolean;
	/** Same meaning as `RecordOpInfo.implicitLoop` / `DangerousCallInfo.implicitLoop`. */
	implicitLoop?: string;
}

export interface LoopInfo {
	type: "repeat" | "for" | "foreach" | "while";
	lineStart: number;
	lineEnd: number;
}

export type RecordOpType =
	| "FindSet"
	| "FindFirst"
	| "FindLast"
	| "Find"
	| "Get"
	| "CalcFields"
	| "CalcSums"
	| "Modify"
	| "ModifyAll"
	| "Insert"
	| "Delete"
	| "DeleteAll"
	| "SetLoadFields"
	| "SetRange"
	| "SetFilter"
	| "SetView"
	| "Reset"
	| "Next"
	| "Count"
	| "CountApprox"
	| "IsEmpty";

export interface RecordOpInfo {
	type: RecordOpType;
	line: number;
	column: number;
	insideLoop: boolean;
	recordVariable?: string;
	/** First argument string for SetRange/SetFilter (the field name being filtered) */
	fieldArgument?: string;
	/** All field arguments for SetLoadFields, CalcFields, and CalcSums calls */
	allFieldArguments?: string[];
	/**
	 * Set when `insideLoop` is true because this op sits in a per-row trigger
	 * (Report/XmlPort/Page `OnAfterGetRecord`) rather than a syntactic loop —
	 * there is no `repeat`/`for`/`foreach`/`while` in the source at all, the
	 * platform itself calls the trigger once per row. Format:
	 * `"<ObjectType>.<TriggerName>"`, e.g. `"Report.OnAfterGetRecord"`.
	 * Detectors must surface this in their evidence/description: a finding
	 * that says "inside a loop" with no visible loop reads as a tool bug.
	 */
	implicitLoop?: string;
}

export interface LineRange {
	start: number;
	end: number;
}
