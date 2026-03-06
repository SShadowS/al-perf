import type { AppBreakdown, ObjectBreakdown, MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern } from "../types/patterns.js";
import type { AIFinding } from "../types/ai-findings.js";

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
    /** Profile confidence score 0-100 */
    confidenceScore: number;
    confidenceFactors: {
      sampleCount: { value: number; score: number };
      duration: { value: number; score: number };
      incompleteMeasurements: { value: number; score: number };
    };
    analyzedAt: string;
  };
  summary: {
    oneLiner: string;
    topApp: { name: string; percent: number } | null;
    topMethod: { name: string; object: string; percent: number } | null;
    patternCount: { critical: number; warning: number; info: number };
    /** Profile health score 0-100 (higher = healthier) */
    healthScore: number;
  };
  criticalPath: CriticalPathStep[];
  hotspots: MethodBreakdown[];
  patterns: DetectedPattern[];
  appBreakdown: AppBreakdown[];
  objectBreakdown: ObjectBreakdown[];
  tableBreakdown?: TableBreakdown[];
  explanation?: string;
  aiFindings?: AIFinding[];
  aiNarrative?: string;
}

export interface TableBreakdown {
  tableName: string;
  /** Total self time across all operations on this table */
  totalSelfTime: number;
  totalSelfTimePercent: number;
  /** Breakdown by operation type */
  operationBreakdown: TableOperationBreakdown[];
  /** Number of distinct procedures that access this table */
  callSiteCount: number;
  /** Whether SetLoadFields is used anywhere for this table */
  hasSetLoadFields: boolean;
  /** Whether filters (SetRange/SetFilter) are used */
  hasFilters: boolean;
}

export interface TableOperationBreakdown {
  operation: string; // "FindSet", "Modify", "CalcFields", etc.
  selfTime: number;
  hitCount: number;
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
  patternDeltas: PatternDelta[];
}

export interface CriticalPathStep {
  functionName: string;
  objectType: string;
  objectId: number;
  objectName: string;
  appName: string;
  selfTime: number;
  totalTime: number;
  totalTimePercent: number;
  depth: number;
}

export interface PatternDelta {
  id: string;
  title: string;
  status: "new" | "resolved" | "changed";
  severity: "critical" | "warning" | "info";
  /** Severity in the before profile (undefined if new) */
  beforeSeverity?: "critical" | "warning" | "info";
  impact: number;
}

export interface SubtreeDrillDown {
  method: {
    functionName: string;
    objectType: string;
    objectId: number;
    appName: string;
    selfTime: number;
    totalTime: number;
    totalTimePercent: number;
    hitCount: number;
  };
  breakdown: {
    selfTimeInMethod: number;
    selfTimePercent: number;
    childContributions: ChildContribution[];
  };
}

export interface ChildContribution {
  functionName: string;
  objectType: string;
  objectId: number;
  appName: string;
  totalTime: number;
  /** Percentage of parent method's totalTime */
  contributionPercent: number;
  hitCount: number;
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
