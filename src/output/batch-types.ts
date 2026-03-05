import type { AnalysisResult } from "./types.js";
import type { AppBreakdown } from "../types/aggregated.js";
import type { ProfileMetadata } from "../types/batch.js";

/** A detected pattern that recurs across multiple profiles in a batch. */
export interface RecurringPattern {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  profileCount: number;
  totalProfiles: number;
  recurrencePercent: number;
  affectedActivities: string[];
}

/** A method aggregated across multiple profiles. */
export interface CumulativeHotspot {
  functionName: string;
  objectType: string;
  objectId: number;
  objectName: string;
  appName: string;
  cumulativeSelfTime: number;
  profileCount: number;
  maxSelfTime: number;
  avgSelfTime: number;
}

/** One row per profile in the batch — the activity dashboard table. */
export interface ActivitySummary {
  profilePath: string;
  healthScore: number;
  patternCount: { critical: number; warning: number; info: number };
  topHotspot: { functionName: string; objectName: string; selfTimePercent: number } | null;
  duration: number;
  metadata?: ProfileMetadata;
}

/** Aggregate analysis result for a batch of profiles. */
export interface BatchAnalysisResult {
  meta: {
    profileCount: number;
    timeRange: { start: string; end: string } | null;
    totalDuration: number;
    activityTypes: Record<string, number>;
    analyzedAt: string;
    sourceAvailable: boolean;
  };
  summary: {
    oneLiner: string;
    overallHealthScore: number;
    worstProfile: { profilePath: string; description: string; healthScore: number } | null;
    totalPatternCount: { critical: number; warning: number; info: number };
  };
  recurringPatterns: RecurringPattern[];
  cumulativeHotspots: CumulativeHotspot[];
  activityBreakdown: ActivitySummary[];
  appBreakdown: AppBreakdown[];
  profiles: AnalysisResult[];
  errors: { profilePath: string; error: string }[];
  explanation?: string;
}
