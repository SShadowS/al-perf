import type { AppBreakdown, ObjectBreakdown, MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern } from "../types/patterns.js";

export interface AnalysisResult {
  meta: {
    profilePath: string;
    profileType: "sampling" | "instrumentation";
    totalDuration: number;
    totalSelfTime: number;
    idleSelfTime: number;
    totalNodes: number;
    maxDepth: number;
    samplingInterval?: number;
    sourceAvailable: boolean;
    builtinSelfTime?: number;
    analyzedAt: string;
  };
  summary: {
    oneLiner: string;
    topApp: { name: string; percent: number } | null;
    topMethod: { name: string; object: string; percent: number } | null;
    patternCount: { critical: number; warning: number; info: number };
  };
  hotspots: MethodBreakdown[];
  patterns: DetectedPattern[];
  appBreakdown: AppBreakdown[];
  objectBreakdown: ObjectBreakdown[];
  explanation?: string;
}

export interface ComparisonResult {
  meta: {
    beforePath: string;
    afterPath: string;
    beforeType: "sampling" | "instrumentation";
    afterType: "sampling" | "instrumentation";
    analyzedAt: string;
  };
  summary: {
    oneLiner: string;
    beforeTotalTime: number;
    afterTotalTime: number;
    deltaTime: number;
    deltaPercent: number;
  };
  regressions: MethodDelta[];
  improvements: MethodDelta[];
  newMethods: MethodBreakdown[];
  removedMethods: MethodBreakdown[];
}

export interface MethodDelta {
  functionName: string;
  objectType: string;
  objectName: string;
  objectId: number;
  appName: string;
  beforeSelfTime: number;
  afterSelfTime: number;
  deltaSelfTime: number;
  deltaPercent: number;
  beforeHitCount: number;
  afterHitCount: number;
}
