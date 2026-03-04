export interface AppBreakdown {
  appName: string;
  appPublisher: string;
  selfTime: number;
  selfTimePercent: number;
  totalTime: number;
  nodeCount: number;
  methods: string[];
}

export interface ObjectBreakdown {
  objectType: string;
  objectName: string;
  objectId: number;
  appName: string;
  selfTime: number;
  selfTimePercent: number;
  totalTime: number;
  methodCount: number;
  methods: MethodBreakdown[];
}

export interface MethodBreakdown {
  functionName: string;
  objectType: string;
  objectName: string;
  objectId: number;
  appName: string;
  selfTime: number;
  selfTimePercent: number;
  totalTime: number;
  totalTimePercent: number;
  hitCount: number;
  calledBy: string[];
  calls: string[];
  // Wall clock time (instrumentation only): sum of (nodeEndTime - nodeStartTime) across instances
  wallClockTime?: number;
  // Gap = wallClockTime - totalTime (estimated I/O / SQL wait time). Clamped to >= 0.
  gapTime?: number;
  // Whether this is a built-in BC code unit (vs custom/extension code)
  isBuiltin?: boolean;
  // Per-line timing data aggregated from positionTicks (instrumentation only)
  lineHotspots?: LineHotspot[];
  costPerHit: number;             // selfTime / hitCount (microseconds per invocation)
  efficiencyScore: number;        // selfTime / totalTime (0.0 = pure orchestrator, 1.0 = all own work)
  callAmplification?: number;     // max(child.hitCount / parent.hitCount) — how much this method fans out vs caller
  sourceLocation?: SourceLocation; // Source file path and line range (when source correlation available)
  /** Per-call statistics across individual instances (instrumentation only) */
  instanceStats?: MethodInstanceStats;
}

export interface MethodInstanceStats {
  /** Number of individual call instances */
  instanceCount: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  stdDev: number;
}

export interface SourceLocation {
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

export interface LineHotspot {
  line: number;
  executionTime: number;        // microseconds
  executionTimePercent: number;  // % of this method's selfTime
}
