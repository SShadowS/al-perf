import { analyzeProfile } from "./analyzer.js";
import type { AnalyzeOptions } from "./analyzer.js";
import type { AnalysisResult } from "../output/types.js";
import type { AppBreakdown, MethodBreakdown } from "../types/aggregated.js";
import type { ProfileMetadata } from "../types/batch.js";
import type {
  BatchAnalysisResult,
  RecurringPattern,
  CumulativeHotspot,
  ActivitySummary,
} from "../output/batch-types.js";
import type { SourceIndex } from "../types/source-index.js";
import { buildSourceIndex } from "../source/indexer.js";

/**
 * Detect whether a profile captured the analyzer itself (e.g. when the BC profiler
 * runs while AnalyzeBatch is executing). Such profiles muddy aggregate results.
 */
export function isSelfReferentialProfile(result: AnalysisResult): boolean {
  return result.hotspots.some((h) => {
    const obj = (h.objectName ?? "").toLowerCase();
    const fn = (h.functionName ?? "").toLowerCase();
    return (
      obj.includes("al perf") ||
      fn.includes("analyzebatch") ||
      fn.includes("analyzeprofile")
    );
  });
}

export interface BatchOptions {
  metadata?: ProfileMetadata[];
  sourcePath?: string;
  sourceIndex?: SourceIndex;
  top?: number;
  appFilter?: string[];
  concurrency?: number;
}

export async function analyzeBatch(
  profilePaths: string[],
  options?: BatchOptions,
): Promise<BatchAnalysisResult> {
  const concurrency = options?.concurrency ?? 8;
  const top = options?.top ?? 10;

  // Build source index once if sourcePath provided
  let sourceIndex = options?.sourceIndex;
  if (!sourceIndex && options?.sourcePath) {
    sourceIndex = await buildSourceIndex(options.sourcePath);
  }

  // Analyze all profiles with bounded concurrency
  const settled = await runWithConcurrency(
    profilePaths,
    async (path) =>
      analyzeProfile(path, {
        top,
        includePatterns: true,
        appFilter: options?.appFilter?.map((s) => s.trim()),
        sourceIndex,
      }),
    concurrency,
  );

  const results: AnalysisResult[] = [];
  const errors: { profilePath: string; error: string }[] = [];
  const succeededIndices: number[] = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
      succeededIndices.push(i);
    } else {
      errors.push({
        profilePath: profilePaths[i],
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  }

  if (results.length === 0) {
    throw new Error(
      `All ${profilePaths.length} profiles failed to analyze. First error: ${errors[0]?.error}`,
    );
  }

  // Filter metadata to match succeeded results so indices stay aligned
  const alignedMetadata = options?.metadata
    ? succeededIndices.map((i) => options.metadata![i]).filter((m): m is ProfileMetadata => m != null)
    : undefined;

  return aggregateResults(results, errors, alignedMetadata);
}

export function aggregateResults(
  results: AnalysisResult[],
  errors: { profilePath: string; error: string }[] = [],
  metadata?: ProfileMetadata[],
): BatchAnalysisResult {
  const cumulativeHotspots = aggregateHotspots(results);
  const recurringPatterns = aggregatePatterns(results, metadata);
  const activityBreakdown = buildActivityBreakdown(results, metadata);
  const appBreakdown = mergeAppBreakdowns(results);
  const summary = computeBatchSummary(results, recurringPatterns, activityBreakdown);
  const meta = computeBatchMeta(results, metadata);

  return {
    meta,
    summary,
    recurringPatterns,
    cumulativeHotspots,
    activityBreakdown,
    appBreakdown,
    profiles: results,
    errors,
  };
}

function computeBatchMeta(
  results: AnalysisResult[],
  metadata?: ProfileMetadata[],
): BatchAnalysisResult["meta"] {
  const totalDuration = results.reduce((sum, r) => sum + r.meta.totalSelfTime, 0);
  const sourceAvailable = results.some((r) => r.meta.sourceAvailable);

  const activityTypes: Record<string, number> = {};
  if (metadata) {
    for (const m of metadata) {
      activityTypes[m.activityType] = (activityTypes[m.activityType] || 0) + 1;
    }
  }

  let timeRange: { start: string; end: string } | null = null;
  if (metadata && metadata.length > 0) {
    const times = metadata.map((m) => new Date(m.startTime).getTime()).filter((t) => !isNaN(t));
    if (times.length > 0) {
      timeRange = {
        start: new Date(Math.min(...times)).toISOString(),
        end: new Date(Math.max(...times)).toISOString(),
      };
    }
  }

  return {
    profileCount: results.length,
    timeRange,
    totalDuration,
    activityTypes,
    analyzedAt: new Date().toISOString(),
    sourceAvailable,
  };
}

function aggregateHotspots(results: AnalysisResult[]): CumulativeHotspot[] {
  const map = new Map<string, {
    functionName: string;
    objectType: string;
    objectId: number;
    objectName: string;
    appName: string;
    totalSelfTime: number;
    profileCount: number;
    maxSelfTime: number;
  }>();

  for (const result of results) {
    const seenInProfile = new Set<string>();
    for (const h of result.hotspots) {
      const key = `${h.functionName}_${h.objectType}_${h.objectId}`;
      const existing = map.get(key);
      if (existing) {
        existing.totalSelfTime += h.selfTime;
        existing.maxSelfTime = Math.max(existing.maxSelfTime, h.selfTime);
        if (!seenInProfile.has(key)) {
          existing.profileCount++;
          seenInProfile.add(key);
        }
      } else {
        seenInProfile.add(key);
        map.set(key, {
          functionName: h.functionName,
          objectType: h.objectType,
          objectId: h.objectId,
          objectName: h.objectName,
          appName: h.appName,
          totalSelfTime: h.selfTime,
          profileCount: 1,
          maxSelfTime: h.selfTime,
        });
      }
    }
  }

  return Array.from(map.values())
    .map((entry) => ({
      functionName: entry.functionName,
      objectType: entry.objectType,
      objectId: entry.objectId,
      objectName: entry.objectName,
      appName: entry.appName,
      cumulativeSelfTime: entry.totalSelfTime,
      profileCount: entry.profileCount,
      maxSelfTime: entry.maxSelfTime,
      avgSelfTime: Math.round(entry.totalSelfTime / entry.profileCount),
    }))
    .sort((a, b) => b.cumulativeSelfTime - a.cumulativeSelfTime);
}

function aggregatePatterns(
  results: AnalysisResult[],
  metadata?: ProfileMetadata[],
): RecurringPattern[] {
  const map = new Map<string, {
    id: string;
    severity: "critical" | "warning" | "info";
    title: string;
    profileIndices: Set<number>;
  }>();

  for (let i = 0; i < results.length; i++) {
    for (const p of results[i].patterns) {
      const existing = map.get(p.id);
      if (existing) {
        existing.profileIndices.add(i);
        if (severityRank(p.severity) > severityRank(existing.severity)) {
          existing.severity = p.severity;
        }
      } else {
        map.set(p.id, {
          id: p.id,
          severity: p.severity,
          title: p.title,
          profileIndices: new Set([i]),
        });
      }
    }
  }

  const totalProfiles = results.length;

  return Array.from(map.values())
    .map((entry) => ({
      id: entry.id,
      severity: entry.severity,
      title: entry.title,
      profileCount: entry.profileIndices.size,
      totalProfiles,
      recurrencePercent: Math.round((entry.profileIndices.size / totalProfiles) * 100),
      affectedActivities: Array.from(entry.profileIndices).map((i) => {
        if (metadata && metadata[i]) return metadata[i].activityDescription;
        return results[i].meta.profilePath;
      }),
    }))
    .sort((a, b) => b.recurrencePercent - a.recurrencePercent || severityRank(b.severity) - severityRank(a.severity));
}

function buildActivityBreakdown(
  results: AnalysisResult[],
  metadata?: ProfileMetadata[],
): ActivitySummary[] {
  return results
    .map((r, i) => {
      const topHotspot = r.hotspots.length > 0
        ? {
            functionName: r.hotspots[0].functionName,
            objectName: r.hotspots[0].objectName,
            selfTimePercent: r.hotspots[0].selfTimePercent,
          }
        : null;

      const selfReferential = isSelfReferentialProfile(r);

      return {
        profilePath: r.meta.profilePath,
        healthScore: r.summary.healthScore,
        patternCount: r.summary.patternCount,
        topHotspot,
        duration: r.meta.totalSelfTime,
        metadata: metadata?.[i],
        ...(selfReferential ? { selfReferential } : {}),
      } satisfies ActivitySummary;
    })
    .sort((a, b) => b.duration - a.duration);
}

function mergeAppBreakdowns(results: AnalysisResult[]): AppBreakdown[] {
  const map = new Map<string, {
    appName: string;
    appPublisher: string;
    selfTime: number;
    totalTime: number;
    nodeCount: number;
  }>();

  for (const result of results) {
    for (const app of result.appBreakdown) {
      const existing = map.get(app.appName);
      if (existing) {
        existing.selfTime += app.selfTime;
        existing.totalTime += app.totalTime;
        existing.nodeCount += app.nodeCount;
      } else {
        map.set(app.appName, {
          appName: app.appName,
          appPublisher: app.appPublisher,
          selfTime: app.selfTime,
          totalTime: app.totalTime,
          nodeCount: app.nodeCount,
        });
      }
    }
  }

  const totalSelfTime = Array.from(map.values()).reduce((sum, a) => sum + a.selfTime, 0);

  return Array.from(map.values())
    .map((entry) => ({
      ...entry,
      selfTimePercent: totalSelfTime > 0 ? (entry.selfTime / totalSelfTime) * 100 : 0,
      methods: [],
    }))
    .sort((a, b) => b.selfTime - a.selfTime);
}

function computeBatchSummary(
  results: AnalysisResult[],
  recurringPatterns: RecurringPattern[],
  activityBreakdown: ActivitySummary[],
): BatchAnalysisResult["summary"] {
  const totalDuration = results.reduce((sum, r) => sum + r.meta.totalSelfTime, 0);
  const weightedHealth = totalDuration > 0
    ? results.reduce((sum, r) => sum + r.summary.healthScore * r.meta.totalSelfTime, 0) / totalDuration
    : 0;
  const overallHealthScore = Math.round(weightedHealth);

  const worst = activityBreakdown.reduce<ActivitySummary | null>(
    (w, a) => (!w || a.healthScore < w.healthScore ? a : w),
    null,
  );

  const totalPatternCount = { critical: 0, warning: 0, info: 0 };
  for (const r of results) {
    totalPatternCount.critical += r.summary.patternCount.critical;
    totalPatternCount.warning += r.summary.patternCount.warning;
    totalPatternCount.info += r.summary.patternCount.info;
  }

  const topRecurring = recurringPatterns[0];
  const recurringNote = topRecurring
    ? ` Most common issue: ${topRecurring.title} (${topRecurring.recurrencePercent}% of profiles).`
    : "";
  const oneLiner = `Batch of ${results.length} profiles — health ${overallHealthScore}/100, ${totalPatternCount.critical} critical patterns.${recurringNote}`;

  return {
    oneLiner,
    overallHealthScore,
    worstProfile: worst
      ? {
          profilePath: worst.profilePath,
          description: worst.metadata?.activityDescription ?? worst.profilePath,
          healthScore: worst.healthScore,
        }
      : null,
    totalPatternCount,
  };
}

function severityRank(severity: "critical" | "warning" | "info"): number {
  switch (severity) {
    case "critical": return 3;
    case "warning": return 2;
    case "info": return 1;
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
