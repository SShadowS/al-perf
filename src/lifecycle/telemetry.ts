/**
 * telemetry.ts — feed a parsed `telemetry-batch` through the existing
 * finding lifecycle (telemetry-ingest plan D2: reuse `evaluateRun`, don't
 * fork it). This wrapper owns exactly the two `RunMetadata` fields a
 * telemetry batch determines for itself — `captureKind` (always
 * `"telemetry"`) and `captureTime` (the batch's `windowEnd`) — everything
 * else (state machine, absence counting, event logging, baselines, sink
 * triggers) is `evaluateRun` unchanged.
 */

import { parseTelemetryBatch } from "../core/telemetry-parser.js";
import { DEFAULT_LIFECYCLE_CONFIG, type LifecycleConfig } from "./config.js";
import {
	type EvaluationOutcome,
	evaluateRun,
	type RunMetadata,
} from "./evaluate.js";
import type { LifecycleStore } from "./store.js";

export function evaluateTelemetryBatch(
	store: LifecycleStore,
	batchJson: unknown,
	run: Omit<RunMetadata, "captureKind" | "captureTime">,
	configPatch?: Partial<LifecycleConfig>,
): EvaluationOutcome {
	// Same merge evaluateRun applies internally — the parser's severity
	// thresholds and signal-count budget must see the SAME effective config
	// the run is then evaluated under.
	const cfg: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, ...configPatch };
	const parsed = parseTelemetryBatch(batchJson, cfg);
	return evaluateRun(
		store,
		parsed.result,
		{ ...run, captureKind: "telemetry", captureTime: parsed.windowEnd },
		configPatch,
	);
}
