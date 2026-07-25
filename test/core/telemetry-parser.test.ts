import { describe, expect, test } from "bun:test";
import {
	parseTelemetryBatch,
	validateSignalAvailability,
} from "../../src/core/telemetry-parser.js";
import {
	DEFAULT_LIFECYCLE_CONFIG,
	type LifecycleConfig,
} from "../../src/lifecycle/config.js";
import {
	computeTelemetryFingerprint,
	formatFingerprint,
} from "../../src/lifecycle/fingerprint.js";
import type { TelemetrySqlEvidence } from "../../src/types/patterns.js";
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

	// windowEnd becomes RunMetadata.captureTime downstream (telemetry.ts) —
	// evaluateRun's canonicalCaptureTime throws on an unparseable value AFTER
	// the web ingest path has already stored the batch (its lifecycle hook
	// swallows evaluation errors), leaving it stored-but-never-evaluated with
	// no re-evaluate API. Must fail closed HERE, before storage.
	test("rejects an unparseable windowEnd, naming the field", () => {
		const doc = batch([signal()], { windowEnd: "not-a-date" });
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/windowEnd/,
		);
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

	// A signalId of "__proto__"/"constructor" must NOT resolve through the
	// prototype chain to an inherited Object.prototype value (thresholds
	// would then have criticalMs/warningMs undefined, silently forcing
	// "info" regardless of maxDurationMs) — it must fall back to "default"
	// like any other unknown signalId.
	test("signalId '__proto__' does not resolve via the prototype chain — falls back to default thresholds", () => {
		const doc = batch([
			signal({ signalId: "__proto__", maxDurationMs: 10_000 }),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns[0]?.severity).toBe("warning"); // default warningMs=10000
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

	// Plan amendment (Task 3, docs/superpowers/plans/2026-07-11-telemetry-ingest.md
	// Task 2 stub rules): one hotspot PER SIGNAL carrying the signal's REAL
	// routine identity, not a deduped "<telemetry>" placeholder — the
	// placeholder never matched a real signal's involvedMethods string in
	// evaluate.ts's collectFindings method-index lookup, so every telemetry
	// finding's stored appId ended up "" and absence gating (D3) broke.
	test("one hotspot per signal, carrying its real routine identity, zero times", () => {
		const doc = batch([
			signal({
				appId: "app-a",
				appName: "App A",
				methodName: "Method1",
				objectType: "Codeunit",
				objectId: 100,
			}),
			signal({
				appId: "app-a",
				appName: "App A",
				methodName: "Method2",
				objectType: "Codeunit",
				objectId: 200,
			}),
			signal({
				appId: "app-b",
				appName: "App B",
				methodName: "Method3",
				objectType: "Table",
				objectId: 300,
			}),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.hotspots).toHaveLength(3); // one per signal, not deduped by app
		for (const h of parsed.result.hotspots) {
			expect(h.selfTime).toBe(0);
			expect(h.totalTime).toBe(0);
			expect(h.hitCount).toBe(0);
			expect(h.appName).not.toBe("");
		}
		expect(parsed.result.hotspots[0]?.functionName).toBe("Method1");
		expect(parsed.result.hotspots[0]?.objectType).toBe("Codeunit");
		expect(parsed.result.hotspots[0]?.objectId).toBe(100);
		expect(parsed.result.hotspots[0]?.appId).toBe("app-a");
		expect(parsed.result.hotspots[1]?.functionName).toBe("Method2");
		expect(parsed.result.hotspots[2]?.functionName).toBe("Method3");
		expect(parsed.result.hotspots[2]?.appId).toBe("app-b");

		// Exercised-apps guarantee (D3) is unaffected: distinct apps still all
		// appear — exercisedAppsOf (evaluate.ts) dedupes by appId itself.
		const appNames = [
			...new Set(parsed.result.hotspots.map((h) => h.appName)),
		].sort();
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

// ---------------------------------------------------------------------------
// Hardening: this parser is attacker-facing once exposed at /api/ingest —
// finite numbers, non-negative counts/durations, integer objectId, and
// non-empty identity strings, all naming field + signal index.
// ---------------------------------------------------------------------------

describe("hardening: numeric validation", () => {
	test("rejects Infinity for maxDurationMs (else impact goes Infinity)", () => {
		const doc = batch([signal({ maxDurationMs: Number.POSITIVE_INFINITY })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*maxDurationMs/,
		);
	});

	test("rejects -Infinity for maxDurationMs", () => {
		const doc = batch([signal({ maxDurationMs: Number.NEGATIVE_INFINITY })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*maxDurationMs/,
		);
	});

	test("rejects a negative count", () => {
		const doc = batch([signal({ count: -3 })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*count/,
		);
	});

	test("rejects a negative maxDurationMs", () => {
		const doc = batch([signal({ maxDurationMs: -1 })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*maxDurationMs/,
		);
	});

	test("rejects a negative avgDurationMs", () => {
		const doc = batch([signal({ avgDurationMs: -1 })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*avgDurationMs/,
		);
	});

	test("rejects a non-integer objectId", () => {
		const doc = batch([signal({ objectId: 50100.5 })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*objectId/,
		);
	});

	test("accepts a zero count/duration (boundary, not rejected)", () => {
		const doc = batch([
			signal({ count: 0, maxDurationMs: 0, avgDurationMs: 0 }),
		]);
		expect(() =>
			parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Responsibility 7: clientType severity ladder (D3) and same-fingerprint
// merge (D4). Task 3.
// ---------------------------------------------------------------------------

describe("responsibility 7: clientType validation", () => {
	test("accepts a valid clientType", () => {
		const doc = batch([signal({ clientType: "Background" })]);
		expect(() =>
			parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG),
		).not.toThrow();
	});

	test("rejects an empty clientType, naming the field and index", () => {
		const doc = batch([signal({ clientType: "" })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*clientType/,
		);
	});

	test("rejects a clientType containing digits/punctuation", () => {
		const doc = batch([signal({ clientType: "Web Client-2" })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*clientType/,
		);
	});

	// clientType enters severity-key composition (`${signalId}@${clientType}`)
	// — same injection posture as signalId. "__proto__" fails the letters-only
	// regex outright (it contains underscores), so it never reaches the
	// composition step.
	test("rejects clientType '__proto__' (fails the regex, same injection posture as signalId)", () => {
		const doc = batch([signal({ clientType: "__proto__" })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*clientType/,
		);
	});

	test("a batch without clientType on any signal is unaffected (optional field)", () => {
		const doc = batch([signal()]);
		expect(() =>
			parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG),
		).not.toThrow();
	});
});

describe("responsibility 7: clientType severity ladder (D3)", () => {
	test("the signalId@clientType composite rung is used when present, else the plain signalId rung", () => {
		const cfg: LifecycleConfig = {
			...DEFAULT_LIFECYCLE_CONFIG,
			telemetry: {
				...DEFAULT_LIFECYCLE_CONFIG.telemetry,
				severity: {
					...DEFAULT_LIFECYCLE_CONFIG.telemetry.severity,
					// Tighter than the plain RT0018 rung (warningMs:10000, criticalMs:30000).
					"RT0018@Background": { warningMs: 5_000, criticalMs: 15_000 },
				},
			},
		};
		// Different objectId => different fingerprint => no merge, so each
		// pattern's severity reflects only its own signal's rung.
		const doc = batch([
			signal({
				signalId: "RT0018",
				clientType: "Background",
				objectId: 1,
				maxDurationMs: 20_000,
			}),
			signal({
				signalId: "RT0018",
				clientType: "WebClient",
				objectId: 2,
				maxDurationMs: 20_000,
			}),
		]);
		const parsed = parseTelemetryBatch(doc, cfg);
		expect(parsed.result.patterns).toHaveLength(2);
		const bg = parsed.result.patterns.find((p) =>
			p.involvedMethods[0]?.includes("Codeunit 1"),
		);
		const web = parsed.result.patterns.find((p) =>
			p.involvedMethods[0]?.includes("Codeunit 2"),
		);
		// Background: 20000 >= composite criticalMs (15000) => critical.
		expect(bg?.severity).toBe("critical");
		// WebClient: no composite key exists for it => falls to plain RT0018
		// rung; 20000 < criticalMs (30000) but >= warningMs (10000) => warning.
		expect(web?.severity).toBe("warning");
	});

	test("an unrecognized clientType simply falls through to the signalId rung", () => {
		const doc = batch([
			signal({
				signalId: "RT0018",
				clientType: "SomeUnknownClientType",
				maxDurationMs: 10_000,
			}),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		// Plain RT0018 rung: warningMs=10000 => warning.
		expect(parsed.result.patterns[0]?.severity).toBe("warning");
	});
});

describe("responsibility 7: same-fingerprint merge (D4)", () => {
	test("two signals for the same routine, different clientType, merge into ONE pattern", () => {
		const doc = batch([
			signal({
				signalId: "RT0018",
				clientType: "Background",
				count: 233,
				maxDurationMs: 76_934,
				avgDurationMs: 50_000,
			}),
			signal({
				signalId: "RT0018",
				clientType: "WebClient",
				count: 12,
				maxDurationMs: 15_200,
				avgDurationMs: 10_000,
			}),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns).toHaveLength(1);
		const p = parsed.result.patterns[0];
		// max severity: Background (76934ms) is critical (>=30000), WebClient
		// (15200ms) is warning (>=10000) => merged severity is critical.
		expect(p?.severity).toBe("critical");
		// summed count
		expect(p?.title).toContain("× 245");
		expect(p?.evidence).toContain("245 occurrence(s)");
		// max maxDurationMs across constituents
		expect(p?.title).toContain("max 76934ms");
		expect(p?.impact).toBe(76_934_000);
		// evidence: one line per constituent, clientType-labeled
		expect(p?.evidence).toContain("Background: 233 × max 76934ms");
		expect(p?.evidence).toContain("WebClient: 12 × max 15200ms");
		// weighted-mean avgDurationMs: (50000*233 + 10000*12) / 245
		const expectedAvg = (50_000 * 233 + 10_000 * 12) / 245;
		expect(p?.evidence).toContain(`avg ${expectedAvg}ms`);
		// window unchanged
		expect(p?.evidence).toContain(
			"in window 2026-07-11T00:00:00.000Z..2026-07-11T01:00:00.000Z",
		);
		// title/involvedMethods from the merged (shared-by-construction) identity
		expect(p?.involvedMethods).toEqual(["ProcessLine (Codeunit 50100)"]);
	});

	test("evidence uses 'unspecified' for a constituent with no clientType", () => {
		const doc = batch([
			signal({ clientType: "Background", count: 5, maxDurationMs: 20_000 }),
			signal({ clientType: undefined, count: 2, maxDurationMs: 8_000 }),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns).toHaveLength(1);
		expect(parsed.result.patterns[0]?.evidence).toContain(
			"unspecified: 2 × max 8000ms",
		);
	});

	test("weighted-mean avgDurationMs is omitted (n/a) when any constituent lacks avgDurationMs", () => {
		const doc = batch([
			signal({ clientType: "Background", avgDurationMs: 5_000 }),
			signal({ clientType: "WebClient", avgDurationMs: undefined }),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns).toHaveLength(1);
		expect(parsed.result.patterns[0]?.evidence).toContain("avg n/ams");
	});

	test("fingerprint of the merged pattern never depends on clientType", () => {
		const withBg = signal({ clientType: "Background" });
		const noClientType = signal({ clientType: undefined });
		const fpBg = parseTelemetryBatch(batch([withBg]), DEFAULT_LIFECYCLE_CONFIG)
			.result.patterns[0]?.fingerprint;
		const fpNone = parseTelemetryBatch(
			batch([noClientType]),
			DEFAULT_LIFECYCLE_CONFIG,
		).result.patterns[0]?.fingerprint;
		expect(fpBg).toBe(fpNone);
	});

	test("hotspots still carry one entry per constituent signal after merge (harmless duplicates)", () => {
		const doc = batch([
			signal({ clientType: "Background" }),
			signal({ clientType: "WebClient" }),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns).toHaveLength(1); // merged
		expect(parsed.result.hotspots).toHaveLength(2); // NOT deduped
	});

	test("three signals for the same routine with distinct clientTypes still merge into ONE pattern", () => {
		const doc = batch([
			signal({ clientType: "Background", count: 1 }),
			signal({ clientType: "WebClient", count: 2 }),
			signal({ clientType: "WebServiceAPI", count: 3 }),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns).toHaveLength(1);
		expect(parsed.result.patterns[0]?.title).toContain("× 6");
	});
});

describe("hardening: non-empty identity strings", () => {
	test("rejects an empty signalId", () => {
		const doc = batch([signal({ signalId: "" })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*signalId/,
		);
	});

	test("rejects a whitespace-only appId", () => {
		const doc = batch([signal({ appId: "   " })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*appId/,
		);
	});

	test("rejects an empty objectType", () => {
		const doc = batch([signal({ objectType: "" })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*objectType/,
		);
	});

	test("rejects an empty methodName (would mint a degenerate fingerprint)", () => {
		const doc = batch([signal({ methodName: "" })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*methodName/,
		);
	});

	test("rejects a whitespace-only methodName", () => {
		const doc = batch([signal({ methodName: "   " })]);
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signal\[0\].*methodName/,
		);
	});
});

// ---------------------------------------------------------------------------
// Responsibility 8: signalAvailability validation (telemetry-sql-evidence
// plan, Task 9). Previously an unvalidated, silently-ignored unknown key —
// this closes that gap: a present-but-malformed entry now fails closed, the
// same way validateSignal's per-field checks do.
// ---------------------------------------------------------------------------

describe("responsibility 8: signalAvailability validation", () => {
	test("validateSignalAvailability returns undefined for an absent field", () => {
		expect(validateSignalAvailability(undefined)).toBeUndefined();
	});

	test("validateSignalAvailability rejects a non-array value", () => {
		expect(() => validateSignalAvailability({})).toThrow(/signalAvailability/);
	});

	test("validateSignalAvailability carries a well-formed entry through, including optional fields", () => {
		const parsed = validateSignalAvailability([
			{
				signalId: "RT0005",
				queried: true,
				rows: 4,
				truncated: true,
				error: "boom",
			},
		]);
		expect(parsed).toEqual([
			{
				signalId: "RT0005",
				queried: true,
				rows: 4,
				truncated: true,
				error: "boom",
			},
		]);
	});

	test("validateSignalAvailability carries a minimal entry through, optional fields undefined", () => {
		const parsed = validateSignalAvailability([
			{ signalId: "RT0005", queried: true, rows: 0 },
		]);
		expect(parsed?.[0].truncated).toBeUndefined();
		expect(parsed?.[0].error).toBeUndefined();
		expect(parsed?.[0].unmatchedRows).toBeUndefined();
	});

	// Fix Round 2 (N1): unmatchedRows surfaces statement rows that matched no
	// signal (e.g. a clientType the routine's signals don't carry) — reuses
	// optionalNonNegativeInteger, same as sqlExecutes/sqlRowsRead.
	test("validateSignalAvailability carries unmatchedRows through", () => {
		const parsed = validateSignalAvailability([
			{
				signalId: "RT0005 statements",
				queried: true,
				rows: 5,
				unmatchedRows: 2,
			},
		]);
		expect(parsed?.[0].unmatchedRows).toBe(2);
	});

	test("rejects a negative unmatchedRows fail-closed", () => {
		const doc = batch([signal()], {
			signalAvailability: [
				{
					signalId: "RT0005 statements",
					queried: true,
					rows: 0,
					unmatchedRows: -1,
				},
			],
		});
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signalAvailability\[0\].*unmatchedRows/,
		);
	});

	test("a well-formed signalAvailability array parses through parseTelemetryBatch without throwing, and is surfaced on the envelope", () => {
		const doc = batch([signal()], {
			signalAvailability: [{ signalId: "RT0018", queried: true, rows: 1 }],
		});
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.signalAvailability).toEqual([
			{ signalId: "RT0018", queried: true, rows: 1 },
		]);
	});

	test("a document with no signalAvailability at all parses with the field left undefined (byte-identical for pre-Task-9 batches)", () => {
		const doc = batch([signal()]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.signalAvailability).toBeUndefined();
		expect(Object.keys(JSON.parse(JSON.stringify(parsed)))).not.toContain(
			"signalAvailability",
		);
	});

	test("rejects a signalAvailability entry missing a required field, naming the field and index", () => {
		const doc = batch([signal()], {
			signalAvailability: [
				{ signalId: "RT0005", rows: 0 },
			] as unknown as TelemetryBatchDocument["signalAvailability"],
		});
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signalAvailability\[0\].*queried/,
		);
	});

	test("rejects a negative rows value fail-closed", () => {
		const doc = batch([signal()], {
			signalAvailability: [{ signalId: "RT0005", queried: true, rows: -1 }],
		});
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signalAvailability\[0\].*rows/,
		);
	});

	test("rejects a non-integer rows value fail-closed", () => {
		const doc = batch([signal()], {
			signalAvailability: [{ signalId: "RT0005", queried: true, rows: 1.5 }],
		});
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signalAvailability\[0\].*rows/,
		);
	});

	test("rejects a non-boolean queried value fail-closed", () => {
		const doc = batch([signal()], {
			signalAvailability: [
				{
					signalId: "RT0005",
					queried: "yes",
					rows: 0,
				} as unknown as NonNullable<
					TelemetryBatchDocument["signalAvailability"]
				>[number],
			],
		});
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signalAvailability\[0\].*queried/,
		);
	});

	test("rejects an empty signalId, naming the field and index", () => {
		const doc = batch([signal()], {
			signalAvailability: [{ signalId: "", queried: true, rows: 0 }],
		});
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signalAvailability\[0\].*signalId/,
		);
	});

	test("rejects a non-array signalAvailability, naming the field", () => {
		const doc = batch([signal()], {
			signalAvailability:
				"nope" as unknown as TelemetryBatchDocument["signalAvailability"],
		});
		expect(() => parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG)).toThrow(
			/signalAvailability/,
		);
	});

	test("does not accidentally alter impact/severity/fingerprint on the associated signal's pattern", () => {
		const s = signal();
		const withoutAvail = parseTelemetryBatch(
			batch([s]),
			DEFAULT_LIFECYCLE_CONFIG,
		);
		const withAvail = parseTelemetryBatch(
			batch([s], {
				signalAvailability: [{ signalId: s.signalId, queried: true, rows: 1 }],
			}),
			DEFAULT_LIFECYCLE_CONFIG,
		);
		expect(withAvail.result.patterns[0]?.impact).toBe(
			withoutAvail.result.patterns[0]?.impact,
		);
		expect(withAvail.result.patterns[0]?.severity).toBe(
			withoutAvail.result.patterns[0]?.severity,
		);
		expect(withAvail.result.patterns[0]?.fingerprint).toBe(
			withoutAvail.result.patterns[0]?.fingerprint,
		);
	});
});

// ---------------------------------------------------------------------------
// Responsibility 9: SQL evidence on patterns (telemetry-sql-evidence plan,
// Task 10). Copies `TelemetrySignal.sqlEvidence` onto `DetectedPattern`,
// formats it into the evidence string (the ONLY thing that survives to an
// issue tracker), merges it across same-fingerprint constituents, and gates
// `meta.incompleteInvocations` on signal-query availability — deliberately
// NOT on the enrichment (RT0005 statements) query. See the amended brief
// (task-10-brief.md, points 1-2) for the rationale this suite pins.
// ---------------------------------------------------------------------------

function sqlStatement(
	overrides: Partial<TelemetrySqlEvidence["statements"][number]> = {},
): TelemetrySqlEvidence["statements"][number] {
	return {
		text: "SELECT * FROM [Sales Line] WHERE [Document No_]=@0",
		operation: "SELECT",
		table: "Sales Line",
		extensionAppId: null,
		occurrences: 1,
		measuredTotalMs: 100,
		truncated: false,
		...overrides,
	};
}

describe("responsibility 9: SQL evidence on patterns (Task 10)", () => {
	test("copies evidence onto the pattern and sets sqlRank in microseconds", () => {
		const evidence: TelemetrySqlEvidence = {
			statements: [sqlStatement({ occurrences: 10, measuredTotalMs: 4200 })],
			totalMeasuredMs: 4200,
			totalOccurrences: 10,
			provenance: "measured-threshold-gated",
			attribution: "telemetry-stack",
		};
		const doc = batch([signal({ sqlEvidence: evidence })]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		const p = parsed.result.patterns[0];
		expect(p?.sqlEvidence?.provenance).toBe("measured-threshold-gated");
		expect(p?.sqlRank).toBe(4200 * 1000);
	});

	test("never touches impact, severity, or fingerprint", () => {
		const evidence: TelemetrySqlEvidence = {
			statements: [sqlStatement()],
			totalMeasuredMs: 500,
			totalOccurrences: 1,
			provenance: "measured-threshold-gated",
			attribution: "telemetry-stack",
		};
		const s = signal();
		const withEvidence = parseTelemetryBatch(
			batch([{ ...s, sqlEvidence: evidence }]),
			DEFAULT_LIFECYCLE_CONFIG,
		);
		const without = parseTelemetryBatch(batch([s]), DEFAULT_LIFECYCLE_CONFIG);
		expect(withEvidence.result.patterns[0]?.impact).toBe(
			without.result.patterns[0]?.impact,
		);
		expect(withEvidence.result.patterns[0]?.severity).toBe(
			without.result.patterns[0]?.severity,
		);
		expect(withEvidence.result.patterns[0]?.fingerprint).toBe(
			without.result.patterns[0]?.fingerprint,
		);
	});

	test("formats up to three statements into the persisted evidence string, plain text", () => {
		// text deliberately omits the literal "SELECT" keyword — the rendered
		// line's own "SELECT" comes from `operation`, so the match count below
		// pins "one rendered line per statement", not an artifact of the text.
		const statements = ["A", "B", "C", "D"].map((label, i) =>
			sqlStatement({
				text: `${label} FROM [Sales Line] WHERE [No_]=@0`,
				occurrences: i + 1,
				measuredTotalMs: 100 * (i + 1),
			}),
		);
		const evidence: TelemetrySqlEvidence = {
			statements,
			totalMeasuredMs: statements.reduce((n, s) => n + s.measuredTotalMs, 0),
			totalOccurrences: statements.reduce((n, s) => n + s.occurrences, 0),
			provenance: "measured-threshold-gated",
			attribution: "telemetry-stack",
			threshold: { minMs: 500, maxMs: 500 },
		};
		// appName carries a value ("CRONUS...") that must NEVER leak into the
		// evidence string — proves the renderer only emits SQL evidence fields,
		// not arbitrary signal metadata.
		const doc = batch([
			signal({ appName: "CRONUS International Ltd.", sqlEvidence: evidence }),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		const p = parsed.result.patterns[0];
		expect(p?.evidence).toContain("SQL (measured");
		expect(p?.evidence.match(/SELECT/g)?.length).toBe(3);
		expect(p?.evidence).not.toContain("```");
		expect(p?.evidence).not.toContain("CRONUS");
	});

	test("a failed non-statement signal marks the run incomplete so absence cannot accrue", () => {
		const doc = batch([signal({ signalId: "RT0005" })], {
			signalAvailability: [
				{ signalId: "RT0005", queried: true, rows: 0, error: "500" },
			],
		});
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.meta.incompleteInvocations).toBeGreaterThan(0);
	});

	test("healthy availability leaves the run complete", () => {
		const doc = batch([signal({ signalId: "RT0005" })], {
			signalAvailability: [{ signalId: "RT0005", queried: true, rows: 4 }],
		});
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.meta.incompleteInvocations ?? 0).toBe(0);
	});

	// Load-bearing (brief point 1): the statement query is enrichment, not a
	// signal query — its failure must NOT suppress the absence pass, or
	// findings that are genuinely fixed would never resolve while the
	// enrichment query happens to be flaky.
	test("a failed RT0005 statements (enrichment) query does NOT mark the run incomplete", () => {
		const doc = batch([signal({ signalId: "RT0005" })], {
			signalAvailability: [
				{
					signalId: "RT0005 statements",
					queried: true,
					rows: 0,
					error: "timeout",
				},
			],
		});
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.meta.incompleteInvocations ?? 0).toBe(0);
	});

	test("a failed RT0005 statements query still surfaces in the evidence note text", () => {
		const evidence: TelemetrySqlEvidence = {
			statements: [],
			totalMeasuredMs: 0,
			totalOccurrences: 0,
			provenance: "measured-threshold-gated",
			attribution: "telemetry-stack",
		};
		const doc = batch([signal({ signalId: "RT0005", sqlEvidence: evidence })], {
			signalAvailability: [
				{
					signalId: "RT0005 statements",
					queried: true,
					rows: 0,
					error: "timeout",
				},
			],
		});
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns[0]?.evidence).toContain(
			"RT0005 statements (timeout)",
		);
	});

	// Fix Round 1 (CRITICAL): the test above manufactures an empty sqlEvidence
	// object to force the note-attachment gate open, which never exercises the
	// REAL shape a statement-query failure produces. attachEvidenceToSignals
	// (telemetry-sql.ts) only sets `signal.sqlEvidence` when at least one
	// statement row matched — so when the statement query itself fails, no
	// rows exist and sqlEvidence stays undefined on every signal in the
	// window. The note must still surface in that case, or a failed query is
	// silently indistinguishable from "no slow SQL" in the persisted string.
	test("a failed RT0005 statements query surfaces its note even when the signal carries no sqlEvidence at all (the real no-match shape)", () => {
		const doc = batch([signal({ signalId: "RT0005" })], {
			signalAvailability: [
				{
					signalId: "RT0005 statements",
					queried: true,
					rows: 0,
					error: "timeout",
				},
			],
		});
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns[0]?.sqlEvidence).toBeUndefined();
		expect(parsed.result.patterns[0]?.evidence).toContain(
			"RT0005 statements (timeout)",
		);
	});

	test("a merged pattern surfaces the failed-query note even when no constituent carries sqlEvidence", () => {
		const doc = batch(
			[
				signal({ signalId: "RT0005", clientType: "Background" }),
				signal({ signalId: "RT0005", clientType: "WebClient" }),
			],
			{
				signalAvailability: [
					{
						signalId: "RT0005 statements",
						queried: true,
						rows: 0,
						error: "timeout",
					},
				],
			},
		);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns).toHaveLength(1); // same fingerprint merge
		expect(parsed.result.patterns[0]?.sqlEvidence).toBeUndefined();
		expect(parsed.result.patterns[0]?.evidence).toContain(
			"RT0005 statements (timeout)",
		);
	});

	// Load-bearing (brief point 2): rows/unmatchedRows are pull-wide, not
	// per-tenant, and must never be rendered as tenant-specific counts.
	test("rows and unmatchedRows never appear in the evidence note (pull-wide, not per-tenant)", () => {
		const evidence: TelemetrySqlEvidence = {
			statements: [],
			totalMeasuredMs: 0,
			totalOccurrences: 0,
			provenance: "measured-threshold-gated",
			attribution: "telemetry-stack",
		};
		const doc = batch([signal({ signalId: "RT0005", sqlEvidence: evidence })], {
			signalAvailability: [
				{
					signalId: "RT0005 statements",
					queried: true,
					rows: 42,
					unmatchedRows: 7,
					error: "boom",
				},
			],
		});
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		const evidenceText = parsed.result.patterns[0]?.evidence ?? "";
		expect(evidenceText).toContain("RT0005 statements (boom)");
		expect(evidenceText).not.toMatch(/\b42\b/);
		expect(evidenceText).not.toMatch(/\b7\b/);
	});

	test("counts line renders only the present field", () => {
		const doc = batch([signal({ sqlExecutes: 12 })]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns[0]?.evidence).toContain(
			"Measured: 12 SQL statement(s)",
		);
		expect(parsed.result.patterns[0]?.evidence).not.toContain("row(s) read");
	});

	test("no counts line and no SQL block when neither sqlExecutes/sqlRowsRead/sqlEvidence is present", () => {
		const doc = batch([signal()]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns[0]?.evidence).not.toContain("Measured:");
		expect(parsed.result.patterns[0]?.evidence).not.toContain("SQL (measured");
	});

	test("merges evidence across clientType constituents without double-counting", () => {
		const stmtText = "SELECT * FROM [Sales Line] WHERE [Document No_]=@0";
		const evidenceA: TelemetrySqlEvidence = {
			statements: [
				sqlStatement({ text: stmtText, occurrences: 2, measuredTotalMs: 800 }),
			],
			totalMeasuredMs: 800,
			totalOccurrences: 2,
			provenance: "measured-threshold-gated",
			attribution: "telemetry-stack",
		};
		const evidenceB: TelemetrySqlEvidence = {
			statements: [
				sqlStatement({
					text: stmtText,
					occurrences: 3,
					measuredTotalMs: 1200,
				}),
			],
			totalMeasuredMs: 1200,
			totalOccurrences: 3,
			provenance: "measured-threshold-gated",
			attribution: "telemetry-stack",
		};
		const doc = batch([
			signal({ clientType: "Background", sqlEvidence: evidenceA }),
			signal({ clientType: "WebClient", sqlEvidence: evidenceB }),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		expect(parsed.result.patterns).toHaveLength(1);
		const p = parsed.result.patterns[0];
		expect(p?.sqlEvidence?.statements).toHaveLength(1); // same text unioned
		expect(p?.sqlEvidence?.totalOccurrences).toBe(5); // 2 + 3
		expect(p?.sqlEvidence?.totalMeasuredMs).toBe(2000);
		expect(p?.sqlRank).toBe(2000 * 1000);
	});

	test("merged pattern renders one counts line per constituent, never summed", () => {
		const doc = batch([
			signal({ clientType: "Background", sqlExecutes: 12, sqlRowsRead: 3400 }),
			signal({ clientType: "WebClient", sqlExecutes: 4 }),
		]);
		const parsed = parseTelemetryBatch(doc, DEFAULT_LIFECYCLE_CONFIG);
		const evidenceText = parsed.result.patterns[0]?.evidence ?? "";
		expect(evidenceText).toContain(
			"Measured: 12 SQL statement(s), 3400 row(s) read (Background)",
		);
		expect(evidenceText).toContain("Measured: 4 SQL statement(s) (WebClient)");
	});
});
