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
}
