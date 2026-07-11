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
