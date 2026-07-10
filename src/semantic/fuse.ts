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

import { fingerprintPatterns } from "../lifecycle/wire.js";
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
	 * Runtime-detected patterns from al-perf's own detectors.
	 * When provided, `fuseProfile`:
	 *  1. calls `corroborate` after `correlate` to enrich matched attributions
	 *     with `corroboratingPatterns` (P3.1), and
	 *  2. re-mints each pattern's `fingerprint` IN PLACE with the correlation
	 *     attributions (lifecycle phase-2 identity upgrade): anchors with a
	 *     confident alsem match move from the fallback key to their stable
	 *     routine identity. Every fusion path passes the SAME array its result
	 *     carries, so upgraded identities flow to the output.
	 * When absent (or empty), both steps are skipped (graceful no-op).
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

	// P3.2b: attach all inventory routines so views.ts can build the
	// stableRoutineId → MethodBreakdown map for causal-chain enrichment.
	// Done here (not in correlate.ts) so correlate stays pure and callers that
	// build FusedModel directly in tests remain valid.
	fused.allRoutines = engine.routines;

	// Lifecycle phase-2 wiring: re-mint pattern fingerprints with the
	// correlation attributions, upgrading confidently-matched anchors from
	// fallback keys to stable routine identities (identity-upgrade semantics —
	// see routineIdentityFromCorrelation).
	if (opts?.patterns && opts.patterns.length > 0) {
		fingerprintPatterns(opts.patterns, methods, fused.attributions);
	}

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
