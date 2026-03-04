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
  calcFormulaType?: "Sum" | "Lookup" | "Count" | "Average" | "Min" | "Max" | "Exist";
  calcFormulaTable?: string;
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
  variables: VariableInfo[];
  nestingDepth: number;
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
}

export interface LineRange {
  start: number;
  end: number;
}
