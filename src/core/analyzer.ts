import { parseProfile } from "./parser.js";
import { processProfile } from "./processor.js";
import { aggregateByApp, aggregateByMethod, aggregateByObject } from "./aggregator.js";
import { runDetectors } from "./patterns.js";
import { buildSourceIndex } from "../source/indexer.js";
import { runSourceDetectors } from "../source/source-patterns.js";
import { matchAllHotspots } from "../source/locator.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { SourceIndex } from "../types/source-index.js";
import type { AnalysisResult, ComparisonResult, MethodDelta } from "../output/types.js";

export interface AnalyzeOptions {
  top?: number;
  threshold?: number;
  appFilter?: string[];
  includePatterns?: boolean;
  sourcePath?: string;
  /** Pre-built source index — skips buildSourceIndex when provided */
  sourceIndex?: SourceIndex;
}

export interface CompareOptions {
  top?: number;
  threshold?: number;
}

/**
 * Format microseconds into a human-readable time string.
 * >=1M -> "X.Xs", >=1K -> "Xms", else "Xus"
 */
export function formatTime(us: number): string {
  const abs = Math.abs(us);
  if (abs >= 1_000_000) {
    return `${(us / 1_000_000).toFixed(1)}s`;
  }
  if (abs >= 1_000) {
    return `${(us / 1_000).toFixed(1)}ms`;
  }
  return `${Math.round(us)}\u00b5s`;
}

function isIdle(method: MethodBreakdown): boolean {
  return method.functionName === "IdleTime" && method.objectId === 0;
}

/**
 * Analyze a single profile file, returning an AnalysisResult with meta, summary,
 * hotspots, patterns, and breakdowns.
 */
export async function analyzeProfile(
  filePath: string,
  options?: AnalyzeOptions,
): Promise<AnalysisResult> {
  const parsed = await parseProfile(filePath);
  const processed = processProfile(parsed);

  const methods = aggregateByMethod(processed);
  const apps = aggregateByApp(processed);
  const objects = aggregateByObject(processed);

  const builtinSelfTime = processed.allNodes
    .filter(n => n.isBuiltinCodeUnitCall === true)
    .reduce((sum, n) => sum + n.selfTime, 0);

  const includePatterns = options?.includePatterns !== false;
  const patterns = includePatterns ? runDetectors(processed) : [];

  // Source correlation
  let sourceIndex: SourceIndex | undefined = options?.sourceIndex;
  const sourceAvailable = !!options?.sourcePath || !!sourceIndex;
  if ((options?.sourcePath || sourceIndex) && includePatterns) {
    if (!sourceIndex) {
      sourceIndex = await buildSourceIndex(options!.sourcePath!);
    }
    const sourcePatterns = runSourceDetectors(methods, sourceIndex);
    patterns.push(...sourcePatterns);
    patterns.sort((a, b) => b.impact - a.impact);
  }

  // Filter out IdleTime from hotspots
  let hotspots = methods.filter((m) => !isIdle(m));

  // Apply threshold filter (threshold is in microseconds)
  if (options?.threshold !== undefined && options.threshold > 0) {
    hotspots = hotspots.filter((m) => m.selfTime >= options.threshold!);
  }

  // Apply app filter
  if (options?.appFilter && options.appFilter.length > 0) {
    const allowed = new Set(options.appFilter);
    hotspots = hotspots.filter((m) => allowed.has(m.appName));
  }

  // Apply top limit
  if (options?.top !== undefined && options.top > 0) {
    hotspots = hotspots.slice(0, options.top);
  }

  // Attach source locations to hotspot methods
  if (sourceIndex) {
    const matches = matchAllHotspots(hotspots, sourceIndex);
    for (const h of hotspots) {
      const key = `${h.functionName}_${h.objectType}_${h.objectId}`;
      const match = matches.get(key);
      if (match) {
        h.sourceLocation = {
          filePath: match.file,
          lineStart: match.lineStart,
          lineEnd: match.lineEnd,
        };
      }
    }
  }

  // Build summary
  const topApp =
    apps.length > 0 && apps[0].selfTimePercent > 0
      ? { name: apps[0].appName, percent: parseFloat(apps[0].selfTimePercent.toFixed(1)) }
      : null;

  const nonIdleMethods = methods.filter((m) => !isIdle(m));
  const topMethod =
    nonIdleMethods.length > 0 && nonIdleMethods[0].selfTimePercent > 0
      ? {
          name: nonIdleMethods[0].functionName,
          object: `${nonIdleMethods[0].objectType} ${nonIdleMethods[0].objectId}`,
          percent: parseFloat(nonIdleMethods[0].selfTimePercent.toFixed(1)),
        }
      : null;

  const patternCount = { critical: 0, warning: 0, info: 0 };
  for (const p of patterns) {
    patternCount[p.severity]++;
  }

  const durationStr = formatTime(processed.activeSelfTime);
  const topMethodStr = topMethod ? `${topMethod.percent}% in ${topMethod.name}` : "no dominant method";
  const oneLiner = `${durationStr} profile, ${topMethodStr}`;

  return {
    meta: {
      profilePath: filePath,
      profileType: processed.type,
      totalDuration: processed.totalDuration,
      totalSelfTime: processed.activeSelfTime,
      idleSelfTime: processed.idleSelfTime,
      totalNodes: processed.nodeCount,
      maxDepth: processed.maxDepth,
      samplingInterval: processed.samplingInterval,
      sourceAvailable,
      builtinSelfTime: builtinSelfTime > 0 ? builtinSelfTime : undefined,
      analyzedAt: new Date().toISOString(),
    },
    summary: {
      oneLiner,
      topApp,
      topMethod,
      patternCount,
    },
    hotspots,
    patterns,
    appBreakdown: apps,
    objectBreakdown: objects,
  };
}

/**
 * Compare two profiles and return a ComparisonResult with regressions,
 * improvements, and new/removed methods.
 */
export async function compareProfiles(
  beforePath: string,
  afterPath: string,
  options?: CompareOptions,
): Promise<ComparisonResult> {
  const [beforeParsed, afterParsed] = await Promise.all([
    parseProfile(beforePath),
    parseProfile(afterPath),
  ]);

  const beforeProcessed = processProfile(beforeParsed);
  const afterProcessed = processProfile(afterParsed);

  const beforeMethods = aggregateByMethod(beforeProcessed);
  const afterMethods = aggregateByMethod(afterProcessed);

  // Build maps keyed by functionName_objectType_objectId
  const makeKey = (m: MethodBreakdown): string =>
    `${m.functionName}_${m.objectType}_${m.objectId}`;

  const beforeMap = new Map<string, MethodBreakdown>();
  for (const m of beforeMethods) {
    beforeMap.set(makeKey(m), m);
  }

  const afterMap = new Map<string, MethodBreakdown>();
  for (const m of afterMethods) {
    afterMap.set(makeKey(m), m);
  }

  // Find matched methods and compute deltas
  const regressions: MethodDelta[] = [];
  const improvements: MethodDelta[] = [];
  const newMethods: MethodBreakdown[] = [];
  const removedMethods: MethodBreakdown[] = [];

  // Methods in both
  for (const [key, afterMethod] of afterMap) {
    const beforeMethod = beforeMap.get(key);
    if (beforeMethod) {
      const deltaSelfTime = afterMethod.selfTime - beforeMethod.selfTime;
      const deltaPercent =
        beforeMethod.selfTime !== 0
          ? (deltaSelfTime / beforeMethod.selfTime) * 100
          : afterMethod.selfTime > 0
            ? 100
            : 0;

      const delta: MethodDelta = {
        functionName: afterMethod.functionName,
        objectType: afterMethod.objectType,
        objectName: afterMethod.objectName,
        objectId: afterMethod.objectId,
        appName: afterMethod.appName,
        beforeSelfTime: beforeMethod.selfTime,
        afterSelfTime: afterMethod.selfTime,
        deltaSelfTime,
        deltaPercent,
        beforeHitCount: beforeMethod.hitCount,
        afterHitCount: afterMethod.hitCount,
      };

      if (deltaSelfTime > 0) {
        regressions.push(delta);
      } else if (deltaSelfTime < 0) {
        improvements.push(delta);
      }
    } else {
      // New method in after
      if (!isIdle(afterMethod)) {
        newMethods.push(afterMethod);
      }
    }
  }

  // Methods only in before (removed)
  for (const [key, beforeMethod] of beforeMap) {
    if (!afterMap.has(key) && !isIdle(beforeMethod)) {
      removedMethods.push(beforeMethod);
    }
  }

  // Sort regressions by deltaSelfTime descending (worst first)
  regressions.sort((a, b) => b.deltaSelfTime - a.deltaSelfTime);
  // Sort improvements by deltaSelfTime ascending (biggest improvement first)
  improvements.sort((a, b) => a.deltaSelfTime - b.deltaSelfTime);
  // Sort new/removed by selfTime descending
  newMethods.sort((a, b) => b.selfTime - a.selfTime);
  removedMethods.sort((a, b) => b.selfTime - a.selfTime);

  // Filter by threshold if specified
  const threshold = options?.threshold;
  if (threshold !== undefined && threshold > 0) {
    const filterByThreshold = (d: MethodDelta) => Math.abs(d.deltaSelfTime) >= threshold;
    regressions.splice(0, regressions.length, ...regressions.filter(filterByThreshold));
    improvements.splice(0, improvements.length, ...improvements.filter(filterByThreshold));
  }

  // Apply top limit if specified
  const top = options?.top;
  const limitedRegressions = top !== undefined && top > 0 ? regressions.slice(0, top) : regressions;
  const limitedImprovements = top !== undefined && top > 0 ? improvements.slice(0, top) : improvements;

  // Build summary
  const beforeTotalTime = beforeProcessed.activeSelfTime;
  const afterTotalTime = afterProcessed.activeSelfTime;
  const deltaTime = afterTotalTime - beforeTotalTime;
  const deltaPercent = beforeTotalTime !== 0 ? (deltaTime / beforeTotalTime) * 100 : 0;

  const sign = deltaTime >= 0 ? "+" : "";
  const oneLiner = `${sign}${formatTime(deltaTime)} (${sign}${deltaPercent.toFixed(1)}%), ${formatTime(beforeTotalTime)} -> ${formatTime(afterTotalTime)}`;

  return {
    meta: {
      beforePath,
      afterPath,
      beforeType: beforeProcessed.type,
      afterType: afterProcessed.type,
      analyzedAt: new Date().toISOString(),
    },
    summary: {
      oneLiner,
      beforeTotalTime,
      afterTotalTime,
      deltaTime,
      deltaPercent,
    },
    regressions: limitedRegressions,
    improvements: limitedImprovements,
    newMethods,
    removedMethods,
  };
}
