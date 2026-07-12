/**
 * evaluate.test.ts — lifecycle evaluation scenarios (spec §4):
 * first-seen, idempotent re-processing per (fingerprint, profileId),
 * compatible-absence counting (kind/stream/app guards), resolve after N,
 * reopen-after-resolved, fresh-filing after closed, event-time replay
 * guard, incomplete-capture exclusion, baseline-driven regression.
 */

import { describe, expect, it } from "bun:test";
import {
	evaluateRun,
	type RunMetadata,
	StaleAlgoVersionError,
} from "../../src/lifecycle/evaluate.js";
import { FINGERPRINT_ALGO_VERSION } from "../../src/lifecycle/fingerprint.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";
import type { AnalysisResult } from "../../src/output/types.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

const FP = "pattern:deadbeef00000001";

function makeMethod(overrides?: Partial<MethodBreakdown>): MethodBreakdown {
	return {
		functionName: "PostOrder",
		objectType: "codeunit",
		objectName: "Order Post",
		objectId: 50100,
		appName: "My App",
		appId: "abc123",
		selfTime: 1_000_000,
		selfTimePercent: 50,
		totalTime: 1_200_000,
		totalTimePercent: 60,
		hitCount: 10,
		calledBy: [],
		calls: [],
		costPerHit: 100_000,
		efficiencyScore: 0.8,
		...overrides,
	};
}

function makePattern(overrides?: Partial<DetectedPattern>): DetectedPattern {
	return {
		id: "calcfields-in-loop",
		severity: "warning",
		title: "CalcFields inside loop",
		description: "d",
		impact: 500_000,
		involvedMethods: ["PostOrder (codeunit 50100)"],
		evidence: "e",
		fingerprint: FP,
		...overrides,
	};
}

function makeResult(args?: {
	patterns?: DetectedPattern[];
	methods?: MethodBreakdown[];
	incompleteInvocations?: number;
}): AnalysisResult {
	const methods = args?.methods ?? [makeMethod()];
	return {
		meta: {
			profilePath: "p.alcpuprofile",
			profileType: "sampling",
			totalDuration: 2_000_000,
			totalSelfTime: 2_000_000,
			idleSelfTime: 0,
			totalNodes: 10,
			maxDepth: 3,
			incompleteInvocations: args?.incompleteInvocations,
			sourceAvailable: false,
			confidenceScore: 90,
			confidenceFactors: {
				sampleCount: { value: 100, score: 90 },
				duration: { value: 2_000_000, score: 90 },
				incompleteMeasurements: { value: 0, score: 100 },
			},
			analyzedAt: "2026-07-01T10:00:00Z",
		},
		summary: {
			oneLiner: "x",
			topApp: null,
			topMethod: null,
			patternCount: { critical: 0, warning: 1, info: 0 },
			healthScore: 80,
		},
		criticalPath: [],
		hotspots: methods,
		patterns: args?.patterns ?? [makePattern()],
		appBreakdown: [],
		objectBreakdown: [
			{
				objectType: "codeunit",
				objectName: "Order Post",
				objectId: 50100,
				appName: "My App",
				selfTime: 1_000_000,
				selfTimePercent: 50,
				totalTime: 1_200_000,
				methodCount: methods.length,
				methods,
			},
		],
	};
}

function makeRun(overrides?: Partial<RunMetadata>): RunMetadata {
	return {
		tenant: "t1",
		stream: "nightly",
		profileId: `p-${Math.random().toString(36).slice(2)}`,
		captureKind: "sampling",
		captureTime: "2026-07-01T10:00:00Z",
		...overrides,
	};
}

// Small config so absence scenarios stay short.
const CFG = { resolveAfterRuns: 2, baselineMinRuns: 2, baselineWindow: 10 };

describe("evaluateRun — presence", () => {
	it("first observation creates a NEW finding with an occurrence and event", () => {
		const store = new LifecycleStore(":memory:");
		const outcome = evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p1" }),
			CFG,
		);
		expect(outcome.transitions).toEqual([
			expect.objectContaining({
				fingerprint: FP,
				from: null,
				to: "new",
				event: "first-seen",
			}),
		]);
		const row = store.getActiveFinding("t1", FP);
		expect(row?.state).toBe("new");
		expect(row?.observedKinds).toEqual(["sampling"]);
		expect(store.countOccurrences(row?.id ?? -1)).toBe(1);
		store.close();
	});

	it("is idempotent per (fingerprint, profileId): re-processing the same profile is a no-op", () => {
		const store = new LifecycleStore(":memory:");
		const run = makeRun({ profileId: "p1" });
		evaluateRun(store, makeResult(), run, CFG);
		const second = evaluateRun(store, makeResult(), run, CFG);
		expect(second.skipped).toBe("duplicate-run");
		expect(second.transitions).toEqual([]);
		expect(
			store.countOccurrences(store.getActiveFinding("t1", FP)?.id ?? -1),
		).toBe(1);
		store.close();
	});

	it("second observation moves new → open", () => {
		const store = new LifecycleStore(":memory:");
		evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p1", captureTime: "2026-07-01T10:00:00Z" }),
			CFG,
		);
		const o = evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p2", captureTime: "2026-07-02T10:00:00Z" }),
			CFG,
		);
		expect(o.transitions[0]).toEqual(
			expect.objectContaining({
				from: "new",
				to: "open",
				event: "seen-normal",
			}),
		);
		store.close();
	});

	it("unfingerprinted patterns are counted and skipped, not crashed on", () => {
		const store = new LifecycleStore(":memory:");
		const result = makeResult({
			patterns: [makePattern({ fingerprint: undefined })],
		});
		const o = evaluateRun(store, result, makeRun(), CFG);
		expect(o.unfingerprinted).toBe(1);
		expect(o.findingsSeen).toBe(0);
		store.close();
	});
});

describe("evaluateRun — absence and resolution", () => {
	function seedOpenFinding(store: LifecycleStore) {
		evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p1", captureTime: "2026-07-01T10:00:00Z" }),
			CFG,
		);
		evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p2", captureTime: "2026-07-02T10:00:00Z" }),
			CFG,
		);
	}
	const emptyResult = () => makeResult({ patterns: [] });

	it("resolves after N consecutive compatible absences", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		evaluateRun(
			store,
			emptyResult(),
			makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }),
			CFG,
		);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(1);
		const o = evaluateRun(
			store,
			emptyResult(),
			makeRun({ profileId: "p4", captureTime: "2026-07-04T10:00:00Z" }),
			CFG,
		);
		const row = store.getActiveFinding("t1", FP);
		expect(row?.state).toBe("resolved");
		// captureTime is canonicalized via Date#toISOString (always .000 millis).
		expect(row?.resolvedAt).toBe("2026-07-04T10:00:00.000Z");
		expect(o.transitions[0]?.event).toBe("resolved");
		store.close();
	});

	it("an observation resets the absence counter", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		evaluateRun(
			store,
			emptyResult(),
			makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }),
			CFG,
		);
		evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p4", captureTime: "2026-07-04T10:00:00Z" }),
			CFG,
		);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(0);
		store.close();
	});

	it("incompatible capture kind never counts absence (sampling finding vs instrumentation run)", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		evaluateRun(
			store,
			emptyResult(),
			makeRun({
				profileId: "p3",
				captureKind: "instrumentation",
				captureTime: "2026-07-03T10:00:00Z",
			}),
			CFG,
		);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(0);
		store.close();
	});

	it("a different stream never counts absence", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		evaluateRun(
			store,
			emptyResult(),
			makeRun({
				profileId: "p3",
				stream: "weekly",
				captureTime: "2026-07-03T10:00:00Z",
			}),
			CFG,
		);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(0);
		store.close();
	});

	it("a run that did not exercise the finding's app never counts absence", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		const otherApp = makeResult({
			patterns: [],
			methods: [
				makeMethod({
					appId: "ffff99",
					appName: "Other App",
					functionName: "Run",
					objectId: 60000,
				}),
			],
		});
		evaluateRun(
			store,
			otherApp,
			makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }),
			CFG,
		);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(0);
		store.close();
	});

	it("a finding with no app identity always counts absence (D7 unknown-app fallback)", () => {
		const store = new LifecycleStore(":memory:");
		const noAppResult = makeResult({
			methods: [makeMethod({ appId: undefined, appName: "" })],
		});
		evaluateRun(
			store,
			noAppResult,
			makeRun({ profileId: "p1", captureTime: "2026-07-01T10:00:00Z" }),
			CFG,
		);
		evaluateRun(
			store,
			noAppResult,
			makeRun({ profileId: "p2", captureTime: "2026-07-02T10:00:00Z" }),
			CFG,
		);
		// A run reporting a completely unrelated app should still count absence
		// for a finding whose own app identity is unknown (row.appId === "" and
		// row.appName === "" both fall through appWasExercised to `true`).
		const otherApp = makeResult({
			patterns: [],
			methods: [
				makeMethod({
					appId: "ffff99",
					appName: "Other App",
					functionName: "Run",
					objectId: 60000,
				}),
			],
		});
		evaluateRun(
			store,
			otherApp,
			makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }),
			CFG,
		);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(1);
		store.close();
	});

	it("appWasExercised falls back to appName when appId is unknown", () => {
		const store = new LifecycleStore(":memory:");
		const noIdResult = makeResult({
			methods: [makeMethod({ appId: undefined, appName: "My App" })],
		});
		evaluateRun(
			store,
			noIdResult,
			makeRun({ profileId: "p1", captureTime: "2026-07-01T10:00:00Z" }),
			CFG,
		);
		evaluateRun(
			store,
			noIdResult,
			makeRun({ profileId: "p2", captureTime: "2026-07-02T10:00:00Z" }),
			CFG,
		);
		// Different appId, SAME appName as the finding's row — the name-fallback
		// arm of appWasExercised (row.appId is "" so the id branch is skipped)
		// must recognize this as exercising the finding's app.
		const sameNameDifferentId = makeResult({
			patterns: [],
			methods: [
				makeMethod({
					appId: "zzzzzz",
					appName: "My App",
					functionName: "Other",
					objectId: 70000,
				}),
			],
		});
		evaluateRun(
			store,
			sameNameDifferentId,
			makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }),
			CFG,
		);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(1);
		store.close();
	});

	it("incomplete captures are excluded from run-counting (no absence, no metrics)", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		const incomplete = makeResult({ patterns: [], incompleteInvocations: 2 });
		const o = evaluateRun(
			store,
			incomplete,
			makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }),
			CFG,
		);
		expect(o.incomplete).toBe(true);
		expect(store.getActiveFinding("t1", FP)?.absenceCount).toBe(0);
		const metricRows = store.db
			.query<{ n: number }, [string]>(
				"SELECT count(*) AS n FROM routine_metrics WHERE profile_id = ?",
			)
			.get("p3");
		expect(metricRows?.n).toBe(0);
		store.close();
	});

	it("a late-arriving OLD run records history but never drives state (event-time replay guard)", () => {
		const store = new LifecycleStore(":memory:");
		seedOpenFinding(store);
		// Old empty run, captured BEFORE the finding was last seen.
		evaluateRun(
			store,
			emptyResult(),
			makeRun({ profileId: "p0", captureTime: "2026-06-01T10:00:00Z" }),
			CFG,
		);
		const row = store.getActiveFinding("t1", FP);
		expect(row?.state).toBe("open");
		expect(row?.absenceCount).toBe(0);
		store.close();
	});
});

describe("evaluateRun — reopen and fresh-filing", () => {
	function resolveFinding(store: LifecycleStore) {
		evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p1", captureTime: "2026-07-01T10:00:00Z" }),
			CFG,
		);
		evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p2", captureTime: "2026-07-02T10:00:00Z" }),
			CFG,
		);
		evaluateRun(
			store,
			makeResult({ patterns: [] }),
			makeRun({ profileId: "p3", captureTime: "2026-07-03T10:00:00Z" }),
			CFG,
		);
		evaluateRun(
			store,
			makeResult({ patterns: [] }),
			makeRun({ profileId: "p4", captureTime: "2026-07-04T10:00:00Z" }),
			CFG,
		);
	}

	it("re-appearance after resolved reopens (→ regressed) WITH history", () => {
		const store = new LifecycleStore(":memory:");
		resolveFinding(store);
		const o = evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p5", captureTime: "2026-07-05T10:00:00Z" }),
			CFG,
		);
		expect(o.transitions[0]).toEqual(
			expect.objectContaining({
				from: "resolved",
				to: "regressed",
				event: "reopened",
			}),
		);
		const row = store.getActiveFinding("t1", FP);
		expect(row?.resolvedAt).toBeNull();
		expect(store.countOccurrences(row?.id ?? -1)).toBe(3); // history retained
		store.close();
	});

	it("re-appearance after CLOSED files a fresh finding with a supersedes link and needs-triage", () => {
		const store = new LifecycleStore(":memory:");
		resolveFinding(store);
		const resolved = store.getActiveFinding("t1", FP);
		store.updateFindingState(resolved?.id ?? -1, {
			state: "closed",
			closedAt: "2026-07-05T00:00:00Z",
		});
		const o = evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p6", captureTime: "2026-07-06T10:00:00Z" }),
			CFG,
		);
		expect(o.transitions[0]?.event).toBe("filed-fresh");
		const fresh = store.getActiveFinding("t1", FP);
		expect(fresh?.id).not.toBe(resolved?.id);
		expect(fresh?.state).toBe("new");
		expect(fresh?.needsTriage).toBe(true);
		expect(fresh?.supersedes).toBe(resolved?.id ?? -1);
		store.close();
	});

	it("a stale backfilled profile arriving no newer than the closed row does NOT file fresh", () => {
		const store = new LifecycleStore(":memory:");
		resolveFinding(store);
		const resolved = store.getActiveFinding("t1", FP);
		store.updateFindingState(resolved?.id ?? -1, {
			state: "closed",
			closedAt: "2026-07-05T00:00:00Z",
		});
		const occurrencesBefore = store.countOccurrences(resolved?.id ?? -1);
		// closed.lastEventAt is still p4's captureTime (2026-07-04T10:00:00Z) —
		// closing doesn't touch it. A backfilled profile captured BEFORE that
		// must record history only, never file a fresh active finding.
		const o = evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p-backfill", captureTime: "2026-07-03T12:00:00Z" }),
			CFG,
		);
		expect(o.transitions).toEqual([]);
		expect(store.getActiveFinding("t1", FP)).toBeNull();
		const stillClosed = store.getFinding(resolved?.id ?? -1);
		expect(stillClosed?.state).toBe("closed");
		expect(stillClosed?.needsTriage).toBe(false);
		// History was recorded against the closed row, not silently dropped.
		expect(store.countOccurrences(resolved?.id ?? -1)).toBe(
			occurrencesBefore + 1,
		);
		store.close();
	});

	it("a late-arriving OLD run cannot resurrect a resolved finding", () => {
		const store = new LifecycleStore(":memory:");
		resolveFinding(store);
		const before = store.getActiveFinding("t1", FP);
		expect(before?.state).toBe("resolved");
		// Old run, captured BEFORE the finding's lastEventAt (the resolution at p4),
		// reports the pattern PRESENT again — must not reopen.
		const o = evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p-old", captureTime: "2026-07-03T12:00:00Z" }),
			CFG,
		);
		expect(o.transitions).toEqual([]);
		const after = store.getActiveFinding("t1", FP);
		expect(after?.id).toBe(before?.id);
		expect(after?.state).toBe("resolved");
		expect(after?.resolvedAt).toBe(before?.resolvedAt);
		store.close();
	});
});

describe("evaluateRun — baseline-driven regression", () => {
	it("a stable finding whose routine blows past its baseline goes to regressed", () => {
		const store = new LifecycleStore(":memory:");
		const at = (d: number) => `2026-07-0${d}T10:00:00Z`;
		for (let d = 1; d <= 3; d++) {
			evaluateRun(
				store,
				makeResult(),
				makeRun({ profileId: `p${d}`, captureTime: at(d) }),
				CFG,
			);
		}
		const slow = makeResult({ methods: [makeMethod({ selfTime: 9_000_000 })] });
		const o = evaluateRun(
			store,
			slow,
			makeRun({ profileId: "p9", captureTime: at(4) }),
			CFG,
		);
		expect(o.transitions[0]).toEqual(
			expect.objectContaining({
				to: "regressed",
				event: "seen-regressed",
				metricClass: "regressed",
			}),
		);
		store.close();
	});

	it("incomplete captures force the qualifier to normal even past the regression threshold", () => {
		const store = new LifecycleStore(":memory:");
		const at = (d: number) => `2026-07-0${d}T10:00:00Z`;
		for (let d = 1; d <= 3; d++) {
			evaluateRun(
				store,
				makeResult(),
				makeRun({ profileId: `p${d}`, captureTime: at(d) }),
				CFG,
			);
		}
		const slow = makeResult({ methods: [makeMethod({ selfTime: 9_000_000 })] });
		evaluateRun(
			store,
			slow,
			makeRun({ profileId: "p4", captureTime: at(4) }),
			CFG,
		);
		expect(store.getActiveFinding("t1", FP)?.state).toBe("regressed");

		// Same magnitude blowout, but this capture is incomplete — the metric
		// qualifier must be forced to "normal" (no baseline consulted at all),
		// so the finding recovers to "open" via seen-normal, NOT seen-regressed.
		const incompleteBlowout = makeResult({
			methods: [makeMethod({ selfTime: 20_000_000 })],
			incompleteInvocations: 5,
		});
		const o = evaluateRun(
			store,
			incompleteBlowout,
			makeRun({ profileId: "p5", captureTime: at(5) }),
			CFG,
		);
		expect(o.incomplete).toBe(true);
		expect(o.transitions[0]).toEqual(
			expect.objectContaining({
				to: "open",
				event: "seen-normal",
				metricClass: "no-baseline",
			}),
		);
		store.close();
	});
});

describe("evaluateRun — transactional atomicity", () => {
	it("a mid-run throw rolls back the WHOLE run — no run row, no finding rows", () => {
		const store = new LifecycleStore(":memory:");
		const p1 = makePattern({ fingerprint: "pattern:aaaa000000000001" });
		const p2 = makePattern({
			id: "modify-in-loop",
			fingerprint: "pattern:bbbb000000000002",
			involvedMethods: ["OtherMethod (codeunit 50200)"],
		});
		const methods = [
			makeMethod(),
			makeMethod({ functionName: "OtherMethod", objectId: 50200 }),
		];
		const result = makeResult({ patterns: [p1, p2], methods });

		// Force the SECOND finding's logEvent call to throw, simulating a
		// mid-run crash after the first finding's insert has already run
		// (but not yet durably committed — it's all one outer transaction).
		let calls = 0;
		const originalLogEvent = store.logEvent.bind(store);
		store.logEvent = (e) => {
			calls++;
			if (calls === 2) throw new Error("simulated crash");
			return originalLogEvent(e);
		};

		expect(() =>
			evaluateRun(store, result, makeRun({ profileId: "px" }), CFG),
		).toThrow("simulated crash");

		// Nothing from this run persisted: not the run row, not either finding.
		expect(store.getRun("t1", "px")).toBeNull();
		expect(store.getActiveFinding("t1", "pattern:aaaa000000000001")).toBeNull();
		expect(store.getActiveFinding("t1", "pattern:bbbb000000000002")).toBeNull();
		store.close();
	});
});

describe("evaluateRun — captureTime canonicalization", () => {
	it("a non-UTC offset input is canonicalized and compares identically to its UTC equivalent", () => {
		const store = new LifecycleStore(":memory:");
		// 08:00+02:00 == 06:00Z
		evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p1", captureTime: "2026-07-01T08:00:00+02:00" }),
			CFG,
		);
		const row = store.getActiveFinding("t1", FP);
		expect(row?.firstSeenAt).toBe("2026-07-01T06:00:00.000Z");

		const o = evaluateRun(
			store,
			makeResult(),
			makeRun({ profileId: "p2", captureTime: "2026-07-02T06:00:00Z" }),
			CFG,
		);
		expect(o.transitions[0]).toEqual(
			expect.objectContaining({
				from: "new",
				to: "open",
				event: "seen-normal",
			}),
		);
		store.close();
	});

	it("rejects an unparseable captureTime with a clear error", () => {
		const store = new LifecycleStore(":memory:");
		expect(() =>
			evaluateRun(
				store,
				makeResult(),
				makeRun({ captureTime: "not-a-date" }),
				CFG,
			),
		).toThrow(/captureTime/);
		store.close();
	});
});

describe("evaluateRun — tenant normalization (debt-closure plan D1)", () => {
	it("two casings of the same tenant land on one finding, not two", () => {
		const store = new LifecycleStore(":memory:");
		evaluateRun(
			store,
			makeResult(),
			makeRun({
				tenant: "ACME",
				profileId: "p1",
				captureTime: "2026-07-01T10:00:00Z",
			}),
			CFG,
		);
		const o = evaluateRun(
			store,
			makeResult(),
			makeRun({
				tenant: "acme",
				profileId: "p2",
				captureTime: "2026-07-02T10:00:00Z",
			}),
			CFG,
		);
		// Second run is a SECOND observation of the SAME finding (new -> open),
		// not a fresh "first-seen" under a case-distinct tenant.
		expect(o.transitions[0]).toEqual(
			expect.objectContaining({
				from: "new",
				to: "open",
				event: "seen-normal",
			}),
		);
		expect(store.getActiveFinding("acme", FP)?.state).toBe("open");
		expect(store.listFindings({ tenant: "acme" }).length).toBe(1);
		// The as-typed, un-normalized casing was never used as a storage key.
		expect(store.getActiveFinding("ACME", FP)).toBeNull();
		store.close();
	});

	it("rejects a blank tenant with a clear error", () => {
		const store = new LifecycleStore(":memory:");
		expect(() =>
			evaluateRun(store, makeResult(), makeRun({ tenant: "   " }), CFG),
		).toThrow(/tenant/);
		store.close();
	});
});

describe("evaluateRun — stale algo-version guard", () => {
	it("refuses to run when active findings carry a different algo version", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding({
			tenant: "acme",
			fingerprint: "pattern:deadbeefdeadbeef",
			algoVersion: FINGERPRINT_ALGO_VERSION + 1,
			state: "open",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: "Stale finding",
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		} satisfies NewFinding);

		expect(() =>
			evaluateRun(store, makeResult(), makeRun({ tenant: "acme" })),
		).toThrow(StaleAlgoVersionError);

		try {
			evaluateRun(store, makeResult(), makeRun({ tenant: "acme" }));
		} catch (err) {
			const e = err as StaleAlgoVersionError;
			expect(e.count).toBe(1);
			expect(e.currentVersion).toBe(FINGERPRINT_ALGO_VERSION);
			expect(e.staleVersions).toEqual([FINGERPRINT_ALGO_VERSION + 1]);
			expect(e.message).toContain("--purge-stale-fingerprints");
			expect(e.message).toContain("--tenant acme");
		}
		store.close();
	});

	it("does not fire when every finding is at the current version", () => {
		const store = new LifecycleStore(":memory:");
		expect(() =>
			evaluateRun(store, makeResult(), makeRun({ tenant: "acme" })),
		).not.toThrow();
		store.close();
	});

	it("is tenant-scoped: another tenant's stale rows do not block this one", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding({
			tenant: "other",
			fingerprint: "pattern:deadbeefdeadbeef",
			algoVersion: FINGERPRINT_ALGO_VERSION + 1,
			state: "open",
			source: "pattern",
			patternId: "calcfields-in-loop",
			title: "Stale finding",
			severity: "critical",
			appId: "",
			appName: "",
			routineKey: "",
			firstSeenAt: "2026-07-01T00:00:00Z",
			lastSeenAt: "2026-07-01T00:00:00Z",
			lastEventAt: "2026-07-01T00:00:00Z",
			observedKinds: ["sampling"],
			observedStreams: ["nightly"],
		} satisfies NewFinding);
		expect(() =>
			evaluateRun(store, makeResult(), makeRun({ tenant: "acme" })),
		).not.toThrow();
		store.close();
	});
});
