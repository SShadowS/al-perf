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
import { correlate } from "./correlate.js";
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
	return correlate(methods, engine);
}
