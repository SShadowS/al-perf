import { resolve } from "path";
import { config } from "../config.js";
import { FINGERPRINT_ALGO_VERSION } from "../lifecycle/fingerprint.js";
import { fingerprintPatterns } from "../lifecycle/wire.js";
import type {
	AnalysisResult,
	ComparisonResult,
	CriticalPathStep,
	MethodDelta,
	PatternDelta,
} from "../output/types.js";
import { runEngineDiff } from "../semantic/diff-runner.js";
import { isAlWorkspaceDir } from "../semantic/engine-runner.js";
import { fuseProfile } from "../semantic/fuse.js";
import { normalizeAppGuid } from "../semantic/identity.js";
import { correlateRegressions } from "../semantic/regression-correlate.js";
import { annotateHotspots, prioritizeFindings } from "../semantic/views.js";
import { buildSourceIndex } from "../source/indexer.js";
import { matchAllHotspots } from "../source/locator.js";
import { extractSnippet } from "../source/snippets.js";
import { runSourceDetectors } from "../source/source-patterns.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { DetectedPattern } from "../types/patterns.js";
import type { ProcessedNode, ProcessedProfile } from "../types/processed.js";
import type { ParsedProfile } from "../types/profile.js";
import type { SourceIndex } from "../types/source-index.js";
import {
	aggregateByApp,
	aggregateByMethod,
	aggregateByObject,
} from "./aggregator.js";
import { parseProfile } from "./parser.js";

// Re-exported for callers (e.g. tests) that previously imported normalizeAppGuid from analyzer.
export { normalizeAppGuid };

import { runDetectors } from "./patterns.js";
import { isIdleNode, processProfile } from "./processor.js";
import { buildTableBreakdown } from "./table-view.js";
import { annotateEstimatedSavings } from "./what-if.js";

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
	/** Callback to access the SourceIndex (for deep AI analysis AST summaries) */
	onSourceIndex?: (index: SourceIndex) => void;
	/** Callback to access the full non-idle method list (untruncated) for fusion (R2-7). */
	onAllMethods?: (methods: MethodBreakdown[]) => void;
}

export interface CompareOptions {
	top?: number;
	threshold?: number;
	/** Path to the AL workspace for the 'before' version (enables regression fusion). */
	beforeSource?: string;
	/** Path to the AL workspace for the 'after' version (enables regression fusion). */
	afterSource?: string;
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
		.filter((r) => !isIdleNode(r))
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
		const nonIdleChildren: ProcessedNode[] = current.children.filter(
			(c) => !isIdleNode(c),
		);
		if (nonIdleChildren.length === 0) break;
		current = nonIdleChildren.sort((a, b) => b.totalTime - a.totalTime)[0];
	}

	return path;
}

function computeConfidenceScore(
	processed: ProcessedProfile,
	parsed: ParsedProfile,
): {
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
		(n) => n.isIncompleteMeasurement === true,
	).length;
	const incompleteScore =
		incompleteCount === 0
			? 100
			: Math.max(0, 100 - (incompleteCount / processed.nodeCount) * 200);

	// Weighted average
	const score = Math.round(
		sampleScore * 0.4 + durationScore * 0.3 + incompleteScore * 0.3,
	);

	return {
		score: Math.max(0, Math.min(100, score)),
		factors: {
			sampleCount: { value: sampleCount, score: Math.round(sampleScore) },
			duration: {
				value: Math.round(durationMs),
				score: Math.round(durationScore),
			},
			incompleteMeasurements: {
				value: incompleteCount,
				score: Math.round(incompleteScore),
			},
		},
	};
}

function isIdle(method: MethodBreakdown): boolean {
	return method.functionName === "IdleTime" && method.objectId === 0;
}

/**
 * Find the `appVersion` of the frames belonging to the WORKSPACE app
 * (matched by `declaringApplication.appId` against the workspace app.json `id`,
 * GUID-normalized on both sides). Returns `undefined` when no frame matches the
 * workspace appId (do NOT fall back to most-frequent — a real BC profile is
 * dominated by third-party/base-app frames, so most-frequent would compare the
 * WRONG app's version and produce spurious version-mismatch noise).
 *
 * Tie-break: when multiple matching frames disagree on version (should not
 * happen for one app in one profile), the FIRST-SEEN version wins.
 *
 * Exported for unit testing.
 */
export function appVersionForApp(
	parsed: ParsedProfile,
	workspaceAppId: string | undefined,
): string | undefined {
	const targetGuid = normalizeAppGuid(workspaceAppId);
	if (!targetGuid) return undefined;
	for (const node of parsed.nodes) {
		const da = node.declaringApplication;
		if (!da?.appVersion) continue;
		if (normalizeAppGuid(da.appId) === targetGuid) {
			// First-seen version for the matched app wins (see tie-break note).
			return da.appVersion;
		}
	}
	return undefined;
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
		.filter((n) => n.isBuiltinCodeUnitCall === true)
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
		options?.onSourceIndex?.(sourceIndex);
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
			? {
					name: apps[0].appName,
					percent: parseFloat(apps[0].selfTimePercent.toFixed(1)),
				}
			: null;

	const nonIdleMethods = methods.filter((m) => !isIdle(m));
	options?.onAllMethods?.(nonIdleMethods);

	// Lifecycle phase-2 wiring: mint a fingerprint for every detected pattern.
	// No fusion has run at this point, so identities use the fallback key —
	// fuseProfile re-mints with stable identities when a workspace fuses later.
	fingerprintPatterns(patterns, nonIdleMethods);
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
	const patternPenalty =
		patternCount.critical * 20 +
		patternCount.warning * 5 +
		patternCount.info * 1;
	const idleRatio = processed.idleSelfTime / (processed.totalSelfTime || 1);
	const idlePenalty = idleRatio > 0.9 ? 20 : idleRatio > 0.7 ? 10 : 0;
	const healthScore = Math.max(
		0,
		Math.min(100, 100 - patternPenalty - idlePenalty),
	);

	// Build table-centric breakdown
	const tableBreakdown = buildTableBreakdown(processed, sourceIndex);

	const durationStr = formatTime(processed.activeSelfTime);
	const topMethodStr = topMethod
		? `${topMethod.percent}% in ${topMethod.name}`
		: "no dominant method";
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
			captureKind: processed.type,
			sourceFormat: processed.sourceFormat,
			incompleteInvocations: processed.irCapture?.incompleteCount,
			sourceAvailable,
			builtinSelfTime: builtinSelfTime > 0 ? builtinSelfTime : undefined,
			confidenceScore: confidence.score,
			confidenceFactors: confidence.factors,
			fingerprintAlgoVersion: FINGERPRINT_ALGO_VERSION,
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

			const deltaTotalTime = afterMethod.totalTime - beforeMethod.totalTime;
			const deltaTotalPercent =
				beforeMethod.totalTime !== 0
					? (deltaTotalTime / beforeMethod.totalTime) * 100
					: afterMethod.totalTime > 0
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
				beforeTotalTime: beforeMethod.totalTime,
				afterTotalTime: afterMethod.totalTime,
				deltaTotalTime,
				deltaTotalPercent,
				beforeHitCount: beforeMethod.hitCount,
				afterHitCount: afterMethod.hitCount,
			};

			if (deltaSelfTime > 0 || deltaTotalTime > 0) {
				regressions.push(delta);
			} else if (deltaSelfTime < 0 || deltaTotalTime < 0) {
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
		const filterByThreshold = (d: MethodDelta) =>
			Math.abs(d.deltaSelfTime) >= threshold;
		regressions.splice(
			0,
			regressions.length,
			...regressions.filter(filterByThreshold),
		);
		improvements.splice(
			0,
			improvements.length,
			...improvements.filter(filterByThreshold),
		);
	}

	// Apply top limit if specified
	const top = options?.top;
	const limitedRegressions =
		top !== undefined && top > 0 ? regressions.slice(0, top) : regressions;
	const limitedImprovements =
		top !== undefined && top > 0 ? improvements.slice(0, top) : improvements;

	// Build summary
	const beforeTotalTime = beforeProcessed.activeSelfTime;
	const afterTotalTime = afterProcessed.activeSelfTime;
	const deltaTime = afterTotalTime - beforeTotalTime;
	const deltaPercent =
		beforeTotalTime !== 0 ? (deltaTime / beforeTotalTime) * 100 : 0;

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

	const baseResult: ComparisonResult = {
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

	// -------------------------------------------------------------------------
	// PR2-6 three-tier fusion:
	//   both sources → runEngineDiff + correlateRegressions → regressionFusion
	//   after-only   → fuseProfile on after side → afterFusionViews
	//   neither      → plain comparison (byte-unchanged)
	// Wrapped defensively: a fusion failure must never throw out of compareProfiles.
	// -------------------------------------------------------------------------
	const { beforeSource, afterSource } = options ?? {};

	if (beforeSource && afterSource) {
		// Both-sources tier: full regression fusion (P4.2).
		try {
			if (isAlWorkspaceDir(beforeSource) && isAlWorkspaceDir(afterSource)) {
				const diff = await runEngineDiff(beforeSource, afterSource);
				if (!("disabled" in diff)) {
					// Version guard: compare the WORKSPACE app's version (matched by
					// appId against the profile's declaringApplication.appId) — never
					// the globally most-frequent frame (which is base/3rd-party app).
					const beforeProfileVersion = appVersionForApp(
						beforeParsed,
						diff.beforeAppId,
					);
					const afterProfileVersion = appVersionForApp(
						afterParsed,
						diff.afterAppId,
					);
					const fusion = correlateRegressions(
						{
							regressions: limitedRegressions,
							newMethods,
							removedMethods,
						},
						diff,
						{
							before: beforeProfileVersion,
							after: afterProfileVersion,
						},
					);
					baseResult.regressionFusion = fusion;
				}
			}
		} catch {
			// Fusion failure is non-fatal — result stays without regressionFusion.
		}
	} else if (afterSource && !beforeSource) {
		// After-only fallback: single-snapshot P1–P3 fusion on the after profile.
		try {
			if (isAlWorkspaceDir(afterSource)) {
				const afterNonIdleMethods = afterMethods.filter((m) => !isIdle(m));
				const fuseResult = await fuseProfile(afterNonIdleMethods, afterSource, {
					patterns: afterPatterns,
				});
				if (!("disabled" in fuseResult)) {
					const { weighted, unweighted } = prioritizeFindings(
						fuseResult,
						afterNonIdleMethods,
					);
					// DELIBERATE: annotate over the FULL non-idle method set (not a
					// top-N truncated slice as analyze.ts uses for its hotspots arg).
					// A comparison has no `top` limit on the after side here, so the
					// after-fusion view annotates every method that fused — the
					// broadest honest coverage for the regression context.
					baseResult.afterFusionViews = {
						hotspotAnnotations: annotateHotspots(
							fuseResult,
							afterNonIdleMethods,
						),
						prioritizedFindings: weighted,
						unweightedFindings: unweighted,
						correlationSummary: fuseResult.correlationSummary,
					};
				}
			}
		} catch {
			// Fusion failure is non-fatal — result stays without afterFusionViews.
		}
	}
	// else: neither source, OR before-only (no afterSource) → plain comparison,
	// byte-unchanged, no fusion fields. Before-only intentionally falls through to
	// no-fusion: a diff needs both workspaces, and there is no "before-side"
	// single-snapshot fallback (the regression context is the AFTER state).

	return baseResult;
}
