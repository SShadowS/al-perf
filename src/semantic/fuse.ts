/**
 * fuse.ts — Compose the engine-runner + correlate into a single library entry.
 *
 * `fuseProfile(methods, workspaceDir, opts)` is the single-call public API for
 * the al-perf × al-sem fusion substrate (Phase P1).
 *
 * All failures degrade gracefully to `{ disabled, reason }` — al-perf never
 * crashes when the engine is unavailable. When fusion is explicitly disabled
 * (`opts.fusion === false`) the result is `{ disabled, reason: "fusion disabled" }`
 * without invoking the engine at all.
 */

import type { MethodBreakdown } from "../types/aggregated.js";
import type { FusedModel } from "../types/fused.js";
import type { DetectedPattern } from "../types/patterns.js";
import { correlate } from "./correlate.js";
import { corroborate } from "./corroborate.js";
import {
	type EngineDisabled,
	type RunEngineOptions,
	runEngine,
} from "./engine-runner.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FuseOptions {
	/**
	 * Explicit path to the `alsem` binary.
	 * Falls back to `AL_SEM_BIN` env, then `alsem` on PATH.
	 */
	engine?: string;
	/** Subprocess timeout in milliseconds. Default: 60_000. */
	timeoutMs?: number;
	/**
	 * Set to `false` to skip fusion entirely (no engine call).
	 * Default: `true` (fusion is attempted when a workspace is provided).
	 */
	fusion?: boolean;
	/**
	 * Runtime-detected patterns from al-perf's own detectors (P3.1 corroboration).
	 * When provided, `fuseProfile` calls `corroborate` after `correlate` to enrich
	 * matched attributions with `corroboratingPatterns` for any runtime pattern that
	 * is anchored to that routine and corroborates one of its al-sem findings.
	 * When absent (or empty), corroboration is skipped (graceful no-op).
	 */
	patterns?: DetectedPattern[];
}

export type FuseResult = FusedModel | EngineDisabled;

// ---------------------------------------------------------------------------
// fuseProfile
// ---------------------------------------------------------------------------

/**
 * Run the full al-perf × al-sem fusion pipeline:
 *  1. Invoke the engine (fingerprint + analyze).
 *  2. Correlate the runtime methods against the static analysis.
 *  3. Return a `FusedModel` side-map, or `{ disabled, reason }` on any failure.
 *
 * NEVER throws — all failures degrade to `{ disabled, reason }`.
 *
 * @param methods      The al-perf `MethodBreakdown[]` (from aggregateByMethod /
 *                     aggregateResults).
 * @param workspaceDir Path to the AL workspace directory (must contain app.json).
 *                     This is the same directory as al-perf's `--source`.
 * @param opts         Optional engine path, timeout, and fusion flag.
 */
export async function fuseProfile(
	methods: MethodBreakdown[],
	workspaceDir: string,
	opts?: FuseOptions,
): Promise<FuseResult> {
	// Opt-out: caller explicitly disabled fusion.
	if (opts?.fusion === false) {
		return { disabled: true, reason: "fusion disabled" };
	}

	const runOpts: RunEngineOptions = {
		engine: opts?.engine,
		timeoutMs: opts?.timeoutMs,
	};

	const engine = await runEngine(workspaceDir, runOpts);

	// Engine unavailable → propagate the disabled result as-is.
	if ("disabled" in engine) {
		return engine;
	}

	// Pure correlation — no I/O, no subprocess.
	const fused = correlate(methods, engine);

	// P3.1 corroboration: enrich matched attributions with runtime pattern ids.
	// When patterns is absent or empty, corroborate is a no-op (graceful).
	corroborate(fused, methods, opts?.patterns ?? []);

	return fused;
}

// ---------------------------------------------------------------------------
// formatFusionSummary — the one-line CLI summary string (unit-testable)
// ---------------------------------------------------------------------------

/**
 * Build the one-line al-sem fusion summary for the CLI.
 *
 * Format:
 *   `al-sem fusion: <N> hotspots correlated (<M> findings), <K> clean, <J> ambiguous, <L> blind-spots`
 *
 * where:
 *   N = matched + ambiguous            (correlated hotspots)
 *   M = total findings attached across all attributions
 *   K = matchedClean                   (matched with zero findings, verified clean)
 *   J = ambiguous                      (overloads / colliding trigger names)
 *   L = blindSpot                      (AL frames not in the al-sem universe)
 *
 * NOTE: M sums `findings.length` over EVERY attribution. When two distinct
 * profile frames normalize to the same join key (e.g. two field triggers
 * collapsing to a bare `OnValidate`), each receives the same union of findings,
 * so M can over-count under colliding frames. This is acceptable for a headline
 * summary line; precise de-duplication is a P2 concern.
 */
export function formatFusionSummary(model: FusedModel): string {
	const s = model.correlationSummary;
	let findingsCount = 0;
	for (const attr of model.attributions.values()) {
		findingsCount += attr.findings.length;
	}
	return (
		`al-sem fusion: ${s.matched + s.ambiguous} hotspots correlated` +
		` (${findingsCount} findings),` +
		` ${s.matchedClean} clean,` +
		` ${s.ambiguous} ambiguous,` +
		` ${s.blindSpot} blind-spots`
	);
}
