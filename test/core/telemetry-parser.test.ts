import { describe, expect, test } from "bun:test";
import { parseTelemetryBatch } from "../../src/core/telemetry-parser.js";
import {
	DEFAULT_LIFECYCLE_CONFIG,
	type LifecycleConfig,
} from "../../src/lifecycle/config.js";
import {
	computeTelemetryFingerprint,
	formatFingerprint,
} from "../../src/lifecycle/fingerprint.js";
import type {
	TelemetryBatchDocument,
	TelemetrySignal,
} from "../../src/types/telemetry.js";

function signal(overrides: Partial<TelemetrySignal> = {}): TelemetrySignal {
	return {
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
		...overrides,
	};
}

function batch(
	signals: TelemetrySignal[],
	overrides: Partial<TelemetryBatchDocument> = {},
): TelemetryBatchDocument {
	return {
		schemaVersion: 1,
		payloadType: "telemetry-batch",
		windowStart: "2026-07-11T00:00:00.000Z",
		windowEnd: "2026-07-11T01:00:00.000Z",
		signals,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Responsibility 1: fail-closed shape validation
// ---------------------------------------------------------------------------

describe("responsibility 1: fail-closed shape validation", () => {
	test("throws naming the version on schemaVersion mismatch", () => {
		const doc = { ...batch([signal()]), schemaVersion: 7 };
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/schemaVersion 7/,
		);
	});

	test("throws naming the field for a missing top-level field", () => {
		const doc = batch([signal()]) as Record<string, unknown>;
		delete doc.windowEnd;
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/windowEnd/,
		);
	});

	test("throws naming the field and index for a missing required signal field", () => {
		const doc = batch([signal(), signal()]);
		delete (doc.signals[1] as Record<string, unknown>).maxDurationMs;
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[1\].*maxDurationMs/,
		);
	});

	test("throws on a NaN required numeric signal field", () => {
		const doc = batch([signal({ count: Number.NaN })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*count/,
		);
	});

	test("ignores unknown top-level keys (additive evolution)", () => {
		const doc = { ...batch([signal()]), someFutureField: "x" };
		expect(() =>
			parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG),
		).not.toThrow();
	});

	test("ignores unknown per-signal keys (additive evolution)", () => {
		const doc = batch([signal()]);
		(doc.signals[0] as Record<string, unknown>).someFutureSignalField = 42;
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.signalCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Responsibility 2: signal-count budget
// ---------------------------------------------------------------------------

describe("responsibility 2: signal-count budget", () => {
	test("accepts a batch at the default budget boundary (10000)", () => {
		const signals = Array.from({ length: 10_000 }, () => signal());
		const doc = batch(signals);
		expect(() =>
			parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG),
		).not.toThrow();
	});

	test("rejects a batch exceeding the configured budget", () => {
		const cfg: LifecycleConfig = {
			...DEFAULT_LIFECYCLE_CONFIG,
			telemetry: {
				...DEFAULT_LIFECYCLE_CONFIG.telemetry,
				maxSignalsPerBatch: 2,
			},
		};
		const doc = batch([signal(), signal(), signal()]);
		expect(() => parseTelemetryBatch(doc, cfg)).toThrow(/signal budget/);
	});
});

// ---------------------------------------------------------------------------
// Responsibility 3: fingerprint minting
// ---------------------------------------------------------------------------

describe("responsibility 3: fingerprint minting", () => {
	test("mints the fingerprint via computeTelemetryFingerprint", () => {
		const s = signal();
		const doc = batch([s]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		const expected = formatFingerprint(
			computeTelemetryFingerprint({
				signalId: s.signalId,
				appId: s.appId,
				objectType: s.objectType,
				objectNumber: s.objectId,
				routineName: s.methodName,
			}),
		);
		expect(parsed.result.patterns[0]?.fingerprint).toBe(expected);
		expect(
			parsed.result.patterns[0]?.fingerprint?.startsWith("telemetry:"),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Responsibility 4: severity via config thresholds
// ---------------------------------------------------------------------------

describe("responsibility 4: severity via config thresholds", () => {
	test("RT0018 below warning is info", () => {
		const doc = batch([signal({ signalId: "RT0018", maxDurationMs: 9_999 })]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns[0]?.severity).toBe("info");
	});

	test("RT0018 at warning threshold (10000ms) is warning", () => {
		const doc = batch([signal({ signalId: "RT0018", maxDurationMs: 10_000 })]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns[0]?.severity).toBe("warning");
	});

	test("RT0018 at critical threshold (30000ms) is critical", () => {
		const doc = batch([signal({ signalId: "RT0018", maxDurationMs: 30_000 })]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns[0]?.severity).toBe("critical");
	});

	test("RT0005 uses its own criticalMs (60000), distinct from RT0018", () => {
		const doc = batch([signal({ signalId: "RT0005", maxDurationMs: 30_000 })]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns[0]?.severity).toBe("warning"); // below RT0005's 60000 critical
	});

	test("unknown signalId falls back to the default thresholds", () => {
		const doc = batch([signal({ signalId: "RT9999", maxDurationMs: 60_000 })]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns[0]?.severity).toBe("critical");
	});
});

// ---------------------------------------------------------------------------
// Responsibility 5: stub AnalysisResult (patterns + hotspots + meta)
// ---------------------------------------------------------------------------

describe("responsibility 5: stub AnalysisResult", () => {
	test("pattern fields match the exact construction rules", () => {
		const s = signal({
			signalId: "RT0018",
			methodName: "ProcessLine",
			objectType: "Codeunit",
			objectId: 50100,
			count: 3,
			maxDurationMs: 12_000,
			avgDurationMs: 9_500,
		});
		const doc = batch([s], {
			windowStart: "2026-07-11T00:00:00.000Z",
			windowEnd: "2026-07-11T01:00:00.000Z",
		});
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		const p = parsed.result.patterns[0];
		expect(p?.id).toBe("telemetry-rt0018");
		expect(p?.title).toBe(
			"RT0018: ProcessLine (Codeunit 50100) slow — max 12000ms × 3",
		);
		expect(p?.involvedMethods).toEqual(["ProcessLine (Codeunit 50100)"]);
		expect(p?.impact).toBe(12_000_000); // µs
		expect(p?.evidence).toBe(
			"3 occurrence(s) in window 2026-07-11T00:00:00.000Z..2026-07-11T01:00:00.000Z, max 12000ms, avg 9500ms",
		);
	});

	test("evidence falls back to 'n/a' when avgDurationMs is absent", () => {
		const s = signal({ avgDurationMs: undefined });
		const doc = batch([s]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		// Template is literally `avg ${avgDurationMs ?? "n/a"}ms` — no space
		// before "ms", so the fallback renders as "n/ams".
		expect(parsed.result.patterns[0]?.evidence).toContain("avg n/ams");
	});

	test("id is shared across signals with the same signalId (lowercased)", () => {
		const doc = batch([
			signal({ signalId: "RT0018" }),
			signal({ signalId: "rt0018" }),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns[0]?.id).toBe("telemetry-rt0018");
		expect(parsed.result.patterns[1]?.id).toBe("telemetry-rt0018");
	});

	test("one hotspot per distinct app, functionName '<telemetry>', appName set, zero times", () => {
		const doc = batch([
			signal({ appId: "app-a", appName: "App A" }),
			signal({ appId: "app-a", appName: "App A" }),
			signal({ appId: "app-b", appName: "App B" }),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.hotspots).toHaveLength(2);
		for (const h of parsed.result.hotspots) {
			expect(h.functionName).toBe("<telemetry>");
			expect(h.selfTime).toBe(0);
			expect(h.totalTime).toBe(0);
			expect(h.hitCount).toBe(0);
			expect(h.appName).not.toBe("");
		}
		const appNames = parsed.result.hotspots.map((h) => h.appName).sort();
		expect(appNames).toEqual(["App A", "App B"]);
	});

	test("meta carries a placeholder profileType and a real analyzedAt timestamp", () => {
		const doc = batch([signal()]);
		const before = Date.now();
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		const after = Date.now();
		expect(parsed.result.meta.profileType).toBe("instrumentation");
		expect(parsed.result.meta.sourceFormat).toBeUndefined();
		const analyzedAt = new Date(parsed.result.meta.analyzedAt).getTime();
		expect(analyzedAt).toBeGreaterThanOrEqual(before);
		expect(analyzedAt).toBeLessThanOrEqual(after);
	});

	test("windowEnd and signalCount are surfaced on the ParsedTelemetryBatch envelope", () => {
		const doc = batch([signal(), signal()], {
			windowEnd: "2026-07-11T02:00:00.000Z",
		});
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.windowEnd).toBe("2026-07-11T02:00:00.000Z");
		expect(parsed.signalCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Responsibility 6 (fingerprint stability — brief's step 5)
// ---------------------------------------------------------------------------

describe("fingerprint stability", () => {
	test("the same signal in two batches mints the identical fingerprint string", () => {
		const s = signal();
		const first = parseTelemetryBatch(batch([s]), DEFAULT_LIFECYCLE_CONFIG);
		const second = parseTelemetryBatch(
			batch([s], {
				windowStart: "2026-08-01T00:00:00.000Z",
				windowEnd: "2026-08-01T01:00:00.000Z",
			}),
			DEFAULT_LIFECYCLE_CONFIG,
		);
		expect(first.result.patterns[0]?.fingerprint).toBe(
			second.result.patterns[0]?.fingerprint,
		);
	});

	test("differing only in casing/trigger-prefix of methodName still collides (normalizeTriggerName)", () => {
		const bare = signal({ methodName: "OnValidate" });
		const lower = signal({ methodName: "onvalidate" });
		const prefixed = signal({
			methodName: "Sell-to Customer No. - OnValidate",
		});

		const fpBare = parseTelemetryBatch(batch([bare]), DEFAULT_LIFECYCLE_CONFIG)
			.result.patterns[0]?.fingerprint;
		const fpLower = parseTelemetryBatch(
			batch([lower]),
			DEFAULT_LIFECYCLE_CONFIG,
		).result.patterns[0]?.fingerprint;
		const fpPrefixed = parseTelemetryBatch(
			batch([prefixed]),
			DEFAULT_LIFECYCLE_CONFIG,
		).result.patterns[0]?.fingerprint;

		expect(fpLower).toBe(fpBare);
		expect(fpPrefixed).toBe(fpBare);
	});

	test("a different appId mints a different fingerprint", () => {
		const a = signal({ appId: "app-a" });
		const b = signal({ appId: "app-b" });
		const fpA = parseTelemetryBatch(batch([a]), DEFAULT_LIFECYCLE_CONFIG).result
			.patterns[0]?.fingerprint;
		const fpB = parseTelemetryBatch(batch([b]), DEFAULT_LIFECYCLE_CONFIG).result
			.patterns[0]?.fingerprint;
		expect(fpA).not.toBe(fpB);
	});
});
