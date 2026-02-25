// === Raw JSON shapes (as they appear in .alcpuprofile files) ===

export interface RawCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface RawDeclaringApplication {
  appName: string;
  appPublisher: string;
  appVersion: string;
}

export interface RawApplicationDefinition {
  objectType: string;       // "Page", "CodeUnit", "Table", "TableData", etc.
  objectName: string;
  objectId: number;
}

export interface RawPositionTick {
  line: number;
  column: number;
  ticks: number;
  executionTime: number;    // microseconds
}

export interface RawProfileNode {
  id: number;
  callFrame: RawCallFrame;
  hitCount: number;
  children: number[];
  declaringApplication?: RawDeclaringApplication;
  applicationDefinition: RawApplicationDefinition;
  frameIdentifier: number;
  // Instrumentation-only fields
  positionTicks?: RawPositionTick[];
  startTime?: number;
  endTime?: number;
  isIncompleteMeasurement?: boolean;
  isBuiltinCodeUnitCall?: boolean;
}

export interface RawProfile {
  nodes: RawProfileNode[];
  startTime: number;
  endTime: number;
  // Sampling-specific
  kind?: number;                     // 1 = sampling
  // Both formats have these (instrumentation includes them too)
  samples?: number[];
  timeDeltas?: number[];
  // Instrumentation-specific
  sampleExecutionTimes?: number[];
}

// === Processed / normalized types ===

export type ProfileType = "sampling" | "instrumentation";

export interface ParsedProfile {
  type: ProfileType;
  nodes: RawProfileNode[];
  nodeMap: Map<number, RawProfileNode>;
  rootNodes: RawProfileNode[];       // Nodes not referenced as children by any other node
  startTime: number;
  endTime: number;
  totalDuration: number;             // endTime - startTime (microseconds)
  samples?: number[];
  timeDeltas?: number[];
  sampleExecutionTimes?: number[];
  samplingInterval?: number;         // Derived average interval for sampling profiles (microseconds)
}
