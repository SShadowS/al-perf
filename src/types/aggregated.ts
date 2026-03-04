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
}

export interface LineHotspot {
  line: number;
  executionTime: number;        // microseconds
  executionTimePercent: number;  // % of this method's selfTime
}
