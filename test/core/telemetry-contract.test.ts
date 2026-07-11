import { describe, expect, test } from "bun:test";
import {
	isTelemetryBatchDocument,
	parseTelemetryBatch,
} from "../../src/core/telemetry-parser.js";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/lifecycle/config.js";
import { TELEMETRY_BATCH_SCHEMA_VERSION } from "../../src/types/telemetry.js";

function minimalBatch() {
	return {
		schemaVersion: 1,
		payloadType: "telemetry-batch",
		windowStart: "2026-07-11T00:00:00.000Z",
		windowEnd: "2026-07-11T01:00:00.000Z",
		signals: [
			{
				signalId: "RT0018",
				appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				appName: "My ISV App",
				objectType: "Codeunit",
				objectId: 50100,
				objectName: "Order Processor",
				methodName: "ProcessLine",
				count: 3,
				maxDurationMs: 12_000,
				avgDurationMs: 9_500,
			},
		],
	};
}

describe("telemetry-batch schemaVersion contract pin", () => {
	test("the pin is schemaVersion 1", () => {
		expect(TELEMETRY_BATCH_SCHEMA_VERSION).toBe(1);
	});
});

describe("isTelemetryBatchDocument", () => {
	test("recognizes a telemetry-batch document by raw text", () => {
		expect(isTelemetryBatchDocument(JSON.stringify(minimalBatch()))).toBe(true);
	});

	test("rejects raw text without the discriminant", () => {
		expect(isTelemetryBatchDocument(JSON.stringify({ schemaVersion: 1 }))).toBe(
			false,
		);
		expect(isTelemetryBatchDocument("")).toBe(false);
		expect(isTelemetryBatchDocument("not json at all")).toBe(false);
	});
});

describe("parseTelemetryBatch — unknown-key tolerance (additive evolution)", () => {
	test("ignores unknown top-level keys", () => {
		const doc = { ...minimalBatch(), futureTopLevelField: 123 };
		expect(() =>
			parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG),
		).not.toThrow();
	});

	test("ignores unknown per-signal keys", () => {
		const doc = minimalBatch();
		(doc.signals[0] as Record<string, unknown>).futureSignalField = "x";
		expect(() =>
			parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG),
		).not.toThrow();
	});
});

describe("parseTelemetryBatch — fail-closed on shape", () => {
	test("rejects a foreign schemaVersion, naming the version", () => {
		const doc = { ...minimalBatch(), schemaVersion: 2 };
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/schemaVersion 2/,
		);
	});

	test("rejects a missing required top-level field, naming the field", () => {
		const doc = minimalBatch() as Record<string, unknown>;
		delete doc.windowStart;
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/windowStart/,
		);
	});

	test("rejects a missing required signal field, naming the field and index", () => {
		const doc = minimalBatch();
		delete (doc.signals[0] as Record<string, unknown>).objectId;
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*objectId/,
		);
	});
});

describe("library API surface", () => {
	test("telemetry parser and pin are exported from the package root", async () => {
		const api = await import("../../src/index.js");
		expect(typeof api.parseTelemetryBatch).toBe("function");
		expect(typeof api.isTelemetryBatchDocument).toBe("function");
		expect(api.TELEMETRY_BATCH_SCHEMA_VERSION).toBe(1);
	});
});
