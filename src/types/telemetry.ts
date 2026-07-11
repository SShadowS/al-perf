// === telemetry-batch wire format (App Insights telemetry ingestion) ===
//
// Contract source: this repo's docs/superpowers/plans/2026-07-11-telemetry-ingest.md.
// Versioning policy mirrors ir-json (src/types/irjson.ts §3.7): integer
// schemaVersion; breaking changes bump it; additive optional fields do NOT.
// We therefore accept exactly TELEMETRY_BATCH_SCHEMA_VERSION and ignore
// unknown keys.

/** The telemetry-batch schemaVersion this consumer is pinned to. */
export const TELEMETRY_BATCH_SCHEMA_VERSION = 1;

/** One aggregated signal row — already aggregated per routine by the adapter. */
export interface TelemetrySignal {
	/** BC telemetry event id, e.g. "RT0018", "RT0005". Unknown ids are accepted. */
	signalId: string;
	/** Extension/app id GUID (from customDimensions.extensionId). */
	appId: string;
	appName?: string;
	objectType: string;
	objectId: number;
	objectName?: string;
	/** AL method/trigger name (customDimensions.alMethod / alStackTrace head). */
	methodName: string;
	/** Occurrences inside the batch window. */
	count: number;
	maxDurationMs: number;
	avgDurationMs?: number;
}

export interface TelemetryBatchDocument {
	schemaVersion: number; // must equal 1 (integer pin, irjson-style)
	payloadType: "telemetry-batch";
	/** Aggregation window, ISO 8601 UTC. windowEnd is the run's captureTime. */
	windowStart: string;
	windowEnd: string;
	/** Optional adapter provenance, e.g. "appinsights-api". */
	source?: string;
	signals: TelemetrySignal[];
}
