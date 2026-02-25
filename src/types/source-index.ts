export interface SourceIndex {
  /** All indexed AL files */
  files: ALFileInfo[];

  /** All procedures, keyed by name (lowercase) for lookup */
  procedures: Map<string, ProcedureInfo[]>;

  /** All triggers, keyed by name (lowercase) for lookup */
  triggers: Map<string, TriggerInfo[]>;

  /** Object info, keyed by "ObjectType_ObjectId" */
  objects: Map<string, ObjectInfo>;
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
  nestingDepth: number;
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
}

export interface LineRange {
  start: number;
  end: number;
}
