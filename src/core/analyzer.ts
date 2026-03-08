import { parseProfile } from "./parser.js";
import { processProfile, isIdleNode } from "./processor.js";
import { aggregateByApp, aggregateByMethod, aggregateByObject } from "./aggregator.js";
import { runDetectors } from "./patterns.js";
import { annotateEstimatedSavings } from "./what-if.js";
import { buildTableBreakdown } from "./table-view.js";
import { buildSourceIndex } from "../source/indexer.js";
import { runSourceDetectors } from "../source/source-patterns.js";
import { matchAllHotspots } from "../source/locator.js";
import { extractSnippet } from "../source/snippets.js";
import { resolve } from "path";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { SourceIndex } from "../types/source-index.js";
import type { AnalysisResult, ComparisonResult, MethodDelta, PatternDelta, CriticalPathStep } from "../output/types.js";
import type { DetectedPattern } from "../types/patterns.js";
import type { ProcessedProfile, ProcessedNode } from "../types/processed.js";
import type { ParsedProfile } from "../types/profile.js";
import { config } from "../config.js";

export interface AnalyzeOptions {
  top?: number;
  threshold?: number;
  appFilter?: string[];
  includePatterns?: boolean;
  sourcePath?: string;
  /** Pre-built source index — skips buildSourceIndex when provided */
  sourceIndex?: SourceIndex;
  /** Callback to access the ProcessedProfile (for deep AI analysis) */
  onProcessedProfile?: (profile: ProcessedProfile) => void;
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

function extractCriticalPath(profile: ProcessedProfile): CriticalPathStep[] {
  const path: CriticalPathStep[] = [];

  // Start from the non-idle root with highest totalTime
  let current: ProcessedNode | undefined = profile.roots
    .filter(r => !isIdleNode(r))
    .sort((a, b) => b.totalTime - a.totalTime)[0];

  while (current) {
    path.push({
      functionName: current.callFrame.functionName,
      objectType: current.applicationDefinition.objectType,
      objectId: current.applicationDefinition.objectId,
      objectName: current.applicationDefinition.objectName,
      appName: current.declaringApplication?.appName ?? "(System)",
      selfTime: current.selfTime,
      totalTime: current.totalTime,
      totalTimePercent: current.totalTimePercent,
      depth: current.depth,
    });

    // Follow the child with highest totalTime (excluding idle)
    const nonIdleChildren: ProcessedNode[] = current.children.filter(c => !isIdleNode(c));
    if (nonIdleChildren.length === 0) break;
    current = nonIdleChildren.sort((a, b) => b.totalTime - a.totalTime)[0];
  }

  return path;
}

function computeConfidenceScore(processed: ProcessedProfile, parsed: ParsedProfile): {
  score: number;
  factors: {
    sampleCount: { value: number; score: number };
    duration: { value: number; score: number };
    incompleteMeasurements: { value: number; score: number };
  };
} {
  // Factor 1: Sample count (more samples = higher confidence)
  const sampleCount = parsed.samples?.length ?? processed.nodeCount;
  const sampleScore = Math.min(100, (sampleCount / 100) * 100); // 100+ samples = full score

  // Factor 2: Duration (longer profiles capture more behavior)
  const durationMs = processed.totalDuration / 1000;
  const durationScore = Math.min(100, (durationMs / 5000) * 100); // 5s+ = full score

  // Factor 3: Incomplete measurements (fewer = better)
  const incompleteCount = parsed.nodes.filter(
    n => n.isIncompleteMeasurement === true
  ).length;
  const incompleteScore = incompleteCount === 0 ? 100
    : Math.max(0, 100 - (incompleteCount / processed.nodeCount) * 200);

  // Weighted average
  const score = Math.round(
    sampleScore * 0.4 + durationScore * 0.3 + incompleteScore * 0.3
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    factors: {
      sampleCount: { value: sampleCount, score: Math.round(sampleScore) },
      duration: { value: Math.round(durationMs), score: Math.round(durationScore) },
      incompleteMeasurements: { value: incompleteCount, score: Math.round(incompleteScore) },
    },
  };
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
  options?.onProcessedProfile?.(processed);

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

  // Annotate patterns with estimated savings
  annotateEstimatedSavings(patterns);

  // Extract critical path
  const criticalPath = extractCriticalPath(processed);

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

  // Attach source snippets to matched hotspots (for AI and formatters)
  const sourcePath = options?.sourcePath;
  if (sourcePath) {
    const snippetLimit = config.snippetLimit;
    let snippetsRead = 0;
    for (const h of hotspots) {
      if (snippetsRead >= snippetLimit) break;
      if (h.sourceLocation) {
        try {
          h.sourceSnippet = await extractSnippet(
            resolve(sourcePath, h.sourceLocation.filePath),
            h.sourceLocation.lineStart,
            h.sourceLocation.lineEnd,
          );
          snippetsRead++;
        } catch {
          // Source file may not be readable; skip silently
        }
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

  // Compute confidence score
  const confidence = computeConfidenceScore(processed, parsed);

  // Health score: 100 minus penalties for patterns and idle ratio
  const patternPenalty = patternCount.critical * 20 + patternCount.warning * 5 + patternCount.info * 1;
  const idleRatio = processed.idleSelfTime / (processed.totalSelfTime || 1);
  const idlePenalty = idleRatio > 0.9 ? 20 : idleRatio > 0.7 ? 10 : 0;
  const healthScore = Math.max(0, Math.min(100, 100 - patternPenalty - idlePenalty));

  // Build table-centric breakdown
  const tableBreakdown = buildTableBreakdown(processed, sourceIndex);

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
      confidenceScore: confidence.score,
      confidenceFactors: confidence.factors,
      analyzedAt: new Date().toISOString(),
    },
    summary: {
      oneLiner,
      topApp,
      topMethod,
      patternCount,
      healthScore,
    },
    criticalPath,
    hotspots,
    patterns,
    appBreakdown: apps,
    objectBreakdown: objects,
    tableBreakdown: tableBreakdown.length > 0 ? tableBreakdown : undefined,
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

  // Run pattern detection on both profiles and diff
  const beforePatterns = runDetectors(beforeProcessed);
  const afterPatterns = runDetectors(afterProcessed);

  const patternKey = (p: DetectedPattern) =>
    `${p.id}:${p.involvedMethods.slice().sort().join(",")}`;

  const beforePatternMap = new Map<string, DetectedPattern>();
  for (const p of beforePatterns) {
    beforePatternMap.set(patternKey(p), p);
  }
  const afterPatternMap = new Map<string, DetectedPattern>();
  for (const p of afterPatterns) {
    afterPatternMap.set(patternKey(p), p);
  }

  const patternDeltas: PatternDelta[] = [];

  // New patterns (in after but not before)
  for (const [key, p] of afterPatternMap) {
    if (!beforePatternMap.has(key)) {
      patternDeltas.push({
        id: p.id,
        title: p.title,
        status: "new",
        severity: p.severity,
        impact: p.impact,
      });
    }
  }

  // Resolved patterns (in before but not after)
  for (const [key, p] of beforePatternMap) {
    if (!afterPatternMap.has(key)) {
      patternDeltas.push({
        id: p.id,
        title: p.title,
        status: "resolved",
        severity: p.severity,
        impact: p.impact,
      });
    }
  }

  // Changed severity (same key, different severity)
  for (const [key, afterP] of afterPatternMap) {
    const beforeP = beforePatternMap.get(key);
    if (beforeP && beforeP.severity !== afterP.severity) {
      patternDeltas.push({
        id: afterP.id,
        title: afterP.title,
        status: "changed",
        severity: afterP.severity,
        beforeSeverity: beforeP.severity,
        impact: afterP.impact,
      });
    }
  }

  // Sort: new critical first, then resolved
  patternDeltas.sort((a, b) => {
    const statusOrder = { new: 0, changed: 1, resolved: 2 };
    return statusOrder[a.status] - statusOrder[b.status];
  });

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
    patternDeltas,
  };
}
