import type { RawCallFrame, RawDeclaringApplication, RawApplicationDefinition, RawPositionTick } from "./profile.js";

export interface ProcessedNode {
  id: number;
  callFrame: RawCallFrame;
  applicationDefinition: RawApplicationDefinition;
  declaringApplication?: RawDeclaringApplication;
  hitCount: number;
  children: ProcessedNode[];
  parent?: ProcessedNode;
  depth: number;

  // Calculated times (microseconds)
  selfTime: number;
  totalTime: number;

  // As percentages of profile total
  selfTimePercent: number;
  totalTimePercent: number;

  // Instrumentation extras
  positionTicks?: RawPositionTick[];
  nodeStartTime?: number;
  nodeEndTime?: number;
}

export interface ProcessedProfile {
  type: "sampling" | "instrumentation";
  roots: ProcessedNode[];
  allNodes: ProcessedNode[];
  nodeMap: Map<number, ProcessedNode>;
  totalDuration: number;
  totalSelfTime: number;
  maxDepth: number;
  samplingInterval?: number;

  nodeCount: number;
  startTime: number;
  endTime: number;
}
