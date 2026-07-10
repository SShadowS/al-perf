# Fingerprint Wiring (Platform Phase 2 Bridge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the versioned finding-identity contract (`src/lifecycle/fingerprint.ts`) into analysis outputs so every `DetectedPattern` and every fusion finding carries a canonical fingerprint that the phase-3 lifecycle engine can consume straight from `AnalysisResult`.

**Architecture:** A new pure module `src/lifecycle/wire.ts` implements the anchor policy (which involved method identifies a pattern) and stamps `fingerprint` strings onto `DetectedPattern[]`. `analyzeProfile` calls it always (fallback-key identities — works with zero source/fusion); `fuseProfile` calls it again with correlation attributions (the single choke point every fusion path flows through), upgrading confidently-matched anchors to stable routine identities. `views.ts` wraps alsem-native fingerprints under the `alsem:` namespace on `PrioritizedFinding` rows. `compareProfiles` gains a comparability warning when capture kinds/wire formats differ.

**Tech Stack:** Bun, TypeScript, bun:test. No new dependencies.

## Global Constraints

- **Graceful degradation is absolute:** no source, no fusion → fingerprints still computed from fallback keys; analysis output otherwise byte-identical except the new optional fields (`patterns[].fingerprint`, `meta.fingerprintAlgoVersion`, `PrioritizedFinding.fingerprint`, `ComparisonResult.meta.comparabilityWarning`).
- **No new dependencies.** Tabs for indentation (biome-enforced; run `bunx biome check --write .` before each commit).
- **The v1 hash contract is frozen** (golden-pinned in `test/lifecycle/fingerprint.test.ts`). This plan NEVER modifies `src/lifecycle/fingerprint.ts` — only consumes it. All 18 current detectors are routine-anchored: `salientLocation` is always OMITTED from `computePatternFingerprint` calls.
- **TDD per step:** failing test → run to see it fail → implement → run to see it pass → commit.
- **Test commands are exactly** `AI_DISABLED=1 bun test <file>` (the MCP/analyze paths check `AI_DISABLED` to skip Anthropic calls).
- **Formatter parity:** additive fields on existing types only. NO new section types, NO renderer changes in terminal/markdown/html. `bunx tsc --noEmit` must pass (compile-enforced parity via `SectionRenderers<T>` stays intact).
- **Human formatters do not render fingerprints** (out of scope). JSON formatter passes them through automatically (`JSON.stringify`).
- **Out of scope (owned by the parallel phase-3 plan):** SQLite storage, lifecycle states, sinks, telemetry fingerprints, rendering fingerprints in human formatters, fingerprinting `PatternDelta` in compare results.
- **Commits are conventional** and every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`

---

## THE ANCHOR POLICY (decided once, here — binding on all consumers)

**The anchor routine of a `DetectedPattern` is `involvedMethods[0]`, always. No per-detector overrides, no heat-based fallback.**

`DetectedPattern.involvedMethods` entries are display strings `"<functionName> (<objectType> <objectId>)"` (produced by `formatMethodRef` in `src/core/patterns.ts:8`, `methodLabel` in `src/source/source-patterns.ts:25`, and `memberLabel` in `src/source/source-only-patterns.ts:12` — all three emit the identical format). The anchor is resolved back to a `MethodBreakdown` by exact label match, then to a `FingerprintRoutineIdentity` via `routineIdentityFromCorrelation`.

Verified ordering of every detector's `involvedMethods` (read from the detector sources, 2026-07-10):

| Detector | `involvedMethods` content | `[0]` = |
|---|---|---|
| single-method-dominance | `[subject]` (`src/core/patterns.ts:32`) | the dominating method (subject) |
| high-hit-count (sampling variant) | `[child, parent]` (`patterns.ts:78`) | the hot child — the method whose hit count explodes (subject) |
| high-hit-count (ir-json fan-out variant) | `[child, parent]` (`patterns.ts:157`) | same subject as above — both variants agree |
| deep-call-stack | up to 5 deepest nodes in `allNodes` traversal order (`patterns.ts:183`) | first deepest node (deterministic representative) |
| repeated-siblings | `[parent, representative child]` (`patterns.ts:238`) | the PARENT — the loop-owning call site |
| event-subscriber-hotspot | all event-subscriber nodes in `allNodes` order (`patterns.ts:281`) | first subscriber in tree order (deterministic representative) |
| recursive-call | `[subject]` (`patterns.ts:341`) | the recursing method |
| event-chain | chain root first, then chain members (`patterns.ts:409`, root pushed at chain creation) | the ROOT subscriber (subject) |
| calcfields-in-loop, modify-in-loop, record-op-in-loop, missing-setloadfields, incomplete-setloadfields | `[method]` — single entry (`source-patterns.ts`) | the subject |
| nested-loops, unfiltered-findset, event-subscriber-with-loop-ops, event-subscriber-with-loops, dangerous-call-in-loop, unindexed-filter | `[member]` first (`source-only-patterns.ts`; dangerous-call-in-loop lists the member first) | the subject |

**Rationale:** 11 of the 13 detector shapes reachable through `analyzeProfile` put a deliberate, single subject first. The two aggregate detectors (deep-call-stack, event-subscriber-hotspot) emit tree-traversal-ordered lists where `[0]` is an arbitrary-but-deterministic representative — and any alternative choice is equally arbitrary. For repeated-siblings, `[0]` is the parent (not the headline child): defensible because the parent owns the call site/loop and is the routine whose change resolves the finding.

**Rejected alternative — "hottest involved method by selfTime":** relative heat is the *least* stable input across runs of the same scenario. Anchoring on it splits identities whenever two involved methods trade heat ranking between runs — the exact failure fingerprints exist to prevent. Position 0 never depends on timing.

**Granularity consequence (already pinned by the v1 hash contract):** identity = (patternId × anchor routine × appId), no salient location. N instances of the same pattern on one routine (e.g. two `CalcFields` calls in different loops of one method) share ONE fingerprint. The lifecycle engine treats them as one finding with N occurrences — intended.

**Resolution ladder** (every rung deterministic):
1. `involvedMethods[0]` found in the method-label map → identity via `routineIdentityFromCorrelation(attributions.get(methodAttrKey(m)), m)` — stable when a confident alsem match exists, fallback key otherwise; `appId = m.appId ?? ""`.
2. Label parseable (`/^(.+) \((\S+) (\d+)\)$/`, greedy so only the LAST `" ("` starts the object suffix) but method not in the profile set → fallback key from the parsed fields, `appId ""`.
3. Label unparseable, or `involvedMethods` empty → unkeyable-style fallback: `objectType ""`, `objectNumber 0`, routine name = the raw label string (normalized). Same string → same identity, always.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lifecycle/wire.ts` | Create | Anchor policy + `fingerprintPatterns` (pure; the only module that decides pattern anchors) |
| `src/types/patterns.ts` | Modify | `DetectedPattern.fingerprint?: string` |
| `src/output/types.ts` | Modify | `AnalysisResult.meta.fingerprintAlgoVersion?: number`; `ComparisonResult.meta.comparabilityWarning?: string` |
| `src/core/analyzer.ts` | Modify | Call `fingerprintPatterns` in `analyzeProfile` (fallback identities, always); stamp `fingerprintAlgoVersion`; `comparabilityWarning()` helper + compare wiring |
| `src/semantic/fuse.ts` | Modify | Re-mint pattern fingerprints with attributions after `correlate` (the identity-upgrade choke point for CLI/compare/MCP/web) |
| `src/semantic/views.ts` | Modify | `PrioritizedFinding.fingerprint?: string` (`alsem:`-wrapped native fingerprint on weighted + unweighted rows) |
| `src/index.ts` | Modify | Export the fingerprint contract + wiring helpers |
| `test/lifecycle/wire.test.ts` | Create | Unit tests: anchor policy, resolution ladder, determinism, fallback-vs-attributed divergence |
| `test/lifecycle/wire-fuse.integration.test.ts` | Create | Stub-engine integration: `fuseProfile` upgrades fingerprints; disabled engine leaves them untouched |
| `test/core/analyzer.test.ts` | Modify | `analyzeProfile` fingerprint wiring + compare guard tests |
| `test/cli/formatters/json.test.ts` | Modify | JSON passthrough assertion |
| `test/semantic/views.test.ts` | Modify | `alsem:` fingerprints on prioritized findings |

Why the upgrade lives in `fuseProfile`: every fusion path — `src/cli/commands/analyze.ts:232`, `compareProfiles` after-only tier (`src/core/analyzer.ts:654`), `src/mcp/server.ts:217` and `:326`, `web/server.ts:274` — already calls `fuseProfile(methods, workspace, { patterns })` with the same `patterns` array its result carries. One call site inside `fuseProfile` upgrades all five consumers identically; per-site wiring is exactly how two consumers would drift apart.

---

### Task 1: Anchor policy + `src/lifecycle/wire.ts`

**Files:**
- Create: `src/lifecycle/wire.ts`
- Modify: `src/types/patterns.ts` (add `fingerprint?: string`)
- Test: `test/lifecycle/wire.test.ts`

**Interfaces:**
- Consumes (from `src/lifecycle/fingerprint.ts`): `computePatternFingerprint(pattern: PatternFingerprintInput, identity: FingerprintRoutineIdentity, appId: string): FindingFingerprint`, `formatFingerprint(fp: FindingFingerprint): string`, `routineIdentityFromCorrelation(attribution: SemanticAttribution | undefined, method: { appId?: string; objectType: string; objectId: number; functionName: string }): FingerprintRoutineIdentity`. From `src/semantic/correlate.ts`: `methodAttrKey(m: MethodBreakdown): string`.
- Produces (later tasks rely on these exact signatures):
  ```typescript
  export interface PatternAnchor {
  	identity: FingerprintRoutineIdentity;
  	appId: string;
  }
  export function buildMethodLabelMap(
  	methods: MethodBreakdown[],
  ): Map<string, MethodBreakdown>;
  export function resolvePatternAnchor(
  	pattern: DetectedPattern,
  	methodsByLabel: Map<string, MethodBreakdown>,
  	attributions?: Map<string, SemanticAttribution>,
  ): PatternAnchor;
  export function fingerprintPatterns(
  	patterns: DetectedPattern[],
  	methods: MethodBreakdown[],
  	attributions?: Map<string, SemanticAttribution>,
  ): void; // mutates patterns[i].fingerprint in place
  ```

- [ ] **Step 1: Add the `fingerprint` field to `DetectedPattern`**

In `src/types/patterns.ts`, after `savingsExplanation?: string;` (line 15), add:

```typescript
	/**
	 * Canonical finding identity in string form (`pattern:<16-hex>`), minted by
	 * `fingerprintPatterns` (src/lifecycle/wire.ts) per the anchor policy
	 * (anchor = involvedMethods[0]). Fallback-key identity unless al-sem fusion
	 * upgraded the anchor to a stable routine identity (fuseProfile re-mints).
	 * Absent only on pattern objects constructed outside analyzeProfile
	 * (e.g. detector unit tests).
	 */
	fingerprint?: string;
```

- [ ] **Step 2: Write the failing test**

Create `test/lifecycle/wire.test.ts`:

```typescript
/**
 * wire.test.ts — Unit tests for src/lifecycle/wire.ts (fingerprint wiring).
 *
 * Covers:
 *  - buildMethodLabelMap: label round-trip against the detector label format
 *  - resolvePatternAnchor: anchor policy (involvedMethods[0]) + the full
 *    resolution ladder (resolved / parseable-unresolved / unparseable / empty)
 *  - attribution-aware identity (stable when matched, fallback otherwise,
 *    ambiguous NEVER stable)
 *  - fingerprintPatterns: canonical string form, determinism,
 *    fallback-vs-attributed divergence, member-trigger normalization
 */

import { describe, expect, it } from "bun:test";
import {
	computePatternFingerprint,
	formatFingerprint,
} from "../../src/lifecycle/fingerprint.js";
import {
	buildMethodLabelMap,
	fingerprintPatterns,
	resolvePatternAnchor,
} from "../../src/lifecycle/wire.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { SemanticAttribution } from "../../src/types/fused.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

const APP_ID = "437dbf0e-84ff-417a-965d-ed2bb9650972";
const SID = "437dbf0e-84ff-417a-965d-ed2bb9650972:Codeunit:50100#a1b2c3d4";

function makeMethod(
	functionName: string,
	objectType: string,
	objectId: number,
	opts?: Partial<MethodBreakdown>,
): MethodBreakdown {
	return {
		functionName,
		objectType,
		objectName: "TestObject",
		objectId,
		appName: "TestApp",
		selfTime: 1000,
		selfTimePercent: 10,
		totalTime: 2000,
		totalTimePercent: 20,
		hitCount: 5,
		calledBy: [],
		calls: [],
		costPerHit: 200,
		efficiencyScore: 0.5,
		...opts,
	};
}

function makePattern(id: string, involvedMethods: string[]): DetectedPattern {
	return {
		id,
		severity: "warning",
		title: "t",
		description: "d",
		impact: 100,
		involvedMethods,
		evidence: "e",
	};
}

describe("buildMethodLabelMap", () => {
	it('indexes methods by the detector label format "<fn> (<type> <id>)"', () => {
		const m = makeMethod("ProcessRecords", "Codeunit", 50100);
		const map = buildMethodLabelMap([m]);
		expect(map.get("ProcessRecords (Codeunit 50100)")).toBe(m);
	});
});

describe("resolvePatternAnchor", () => {
	const methods = [
		makeMethod("Child", "Codeunit", 50100, { appId: APP_ID }),
		makeMethod("Parent", "Codeunit", 50200, { appId: APP_ID }),
	];
	const byLabel = buildMethodLabelMap(methods);

	it("anchors on involvedMethods[0] — never a later entry", () => {
		const anchor = resolvePatternAnchor(
			makePattern("high-hit-count", [
				"Child (Codeunit 50100)",
				"Parent (Codeunit 50200)",
			]),
			byLabel,
		);
		expect(anchor.identity).toEqual({
			kind: "fallback",
			appId: "437dbf0e84ff417a965ded2bb9650972",
			canonicalObjectType: "Codeunit",
			objectNumber: 50100,
			normalizedRoutineName: "child",
		});
	});

	it("a resolved anchor carries the method's declaring appId", () => {
		const anchor = resolvePatternAnchor(
			makePattern("single-method-dominance", ["Child (Codeunit 50100)"]),
			byLabel,
		);
		expect(anchor.appId).toBe(APP_ID);
	});

	it("a matched attribution upgrades the anchor to a stable identity", () => {
		const attributions = new Map<string, SemanticAttribution>([
			[
				"Child_Codeunit_50100",
				{
					status: "matched",
					findings: [],
					attributionConfidence: "exact",
					stableRoutineId: SID,
				},
			],
		]);
		const anchor = resolvePatternAnchor(
			makePattern("single-method-dominance", ["Child (Codeunit 50100)"]),
			byLabel,
			attributions,
		);
		expect(anchor.identity).toEqual({ kind: "stable", stableRoutineId: SID });
	});

	it("an ambiguous attribution stays on the fallback key (never trust a union)", () => {
		const attributions = new Map<string, SemanticAttribution>([
			[
				"Child_Codeunit_50100",
				{
					status: "ambiguous",
					findings: [],
					attributionConfidence: "ambiguous",
					stableRoutineId: [SID, `${SID}ff`],
				},
			],
		]);
		const anchor = resolvePatternAnchor(
			makePattern("single-method-dominance", ["Child (Codeunit 50100)"]),
			byLabel,
			attributions,
		);
		expect(anchor.identity.kind).toBe("fallback");
	});

	it('a parseable label absent from the method set falls back to the parsed identity with appId ""', () => {
		const anchor = resolvePatternAnchor(
			makePattern("recursive-call", ["Ghost (Table 18)"]),
			byLabel,
		);
		expect(anchor.appId).toBe("");
		expect(anchor.identity).toEqual({
			kind: "fallback",
			appId: "",
			canonicalObjectType: "Table",
			objectNumber: 18,
			normalizedRoutineName: "ghost",
		});
	});

	it('a member-trigger label parses greedily: only the LAST " (" starts the object suffix', () => {
		const anchor = resolvePatternAnchor(
			makePattern("recursive-call", [
				"Sell-to Customer No. - OnValidate (Table 36)",
			]),
			byLabel,
		);
		expect(anchor.identity).toEqual({
			kind: "fallback",
			appId: "",
			canonicalObjectType: "Table",
			objectNumber: 36,
			normalizedRoutineName: "onvalidate",
		});
	});

	it("an unparseable label yields a deterministic unkeyable-style fallback", () => {
		const a = resolvePatternAnchor(makePattern("x", ["not a label"]), byLabel);
		const b = resolvePatternAnchor(makePattern("x", ["not a label"]), byLabel);
		expect(a).toEqual(b);
		expect(a.identity).toEqual({
			kind: "fallback",
			appId: "",
			canonicalObjectType: "",
			objectNumber: 0,
			normalizedRoutineName: "not a label",
		});
	});

	it("empty involvedMethods yields a deterministic empty-key fallback", () => {
		const anchor = resolvePatternAnchor(
			makePattern("deep-call-stack", []),
			byLabel,
		);
		expect(anchor.identity).toEqual({
			kind: "fallback",
			appId: "",
			canonicalObjectType: "",
			objectNumber: 0,
			normalizedRoutineName: "",
		});
	});
});

describe("fingerprintPatterns", () => {
	const methods = [
		makeMethod("ProcessRecords", "Codeunit", 50100, { appId: APP_ID }),
	];

	it("stamps the canonical string form pattern:<16-hex> on every pattern", () => {
		const patterns = [
			makePattern("calcfields-in-loop", ["ProcessRecords (Codeunit 50100)"]),
			makePattern("modify-in-loop", ["ProcessRecords (Codeunit 50100)"]),
		];
		fingerprintPatterns(patterns, methods);
		for (const p of patterns) {
			expect(p.fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
		}
		expect(patterns[0].fingerprint).not.toBe(patterns[1].fingerprint);
	});

	it("is deterministic across runs", () => {
		const a = makePattern("calcfields-in-loop", [
			"ProcessRecords (Codeunit 50100)",
		]);
		const b = makePattern("calcfields-in-loop", [
			"ProcessRecords (Codeunit 50100)",
		]);
		fingerprintPatterns([a], methods);
		fingerprintPatterns([b], methods);
		expect(a.fingerprint).toBe(b.fingerprint);
	});

	it("matches computePatternFingerprint over the resolved anchor (no hidden inputs)", () => {
		const p = makePattern("calcfields-in-loop", [
			"ProcessRecords (Codeunit 50100)",
		]);
		fingerprintPatterns([p], methods);
		const expected = formatFingerprint(
			computePatternFingerprint(
				{ patternId: "calcfields-in-loop" },
				{
					kind: "fallback",
					appId: "437dbf0e84ff417a965ded2bb9650972",
					canonicalObjectType: "Codeunit",
					objectNumber: 50100,
					normalizedRoutineName: "processrecords",
				},
				APP_ID,
			),
		);
		expect(p.fingerprint).toBe(expected);
	});

	it("fallback vs attributed identities diverge for the same pattern (the identity-upgrade seam)", () => {
		const fallbackP = makePattern("calcfields-in-loop", [
			"ProcessRecords (Codeunit 50100)",
		]);
		const attributedP = makePattern("calcfields-in-loop", [
			"ProcessRecords (Codeunit 50100)",
		]);
		fingerprintPatterns([fallbackP], methods);
		fingerprintPatterns(
			[attributedP],
			methods,
			new Map<string, SemanticAttribution>([
				[
					"ProcessRecords_Codeunit_50100",
					{
						status: "matched",
						findings: [],
						attributionConfidence: "exact",
						stableRoutineId: SID,
					},
				],
			]),
		);
		expect(fallbackP.fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
		expect(attributedP.fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
		expect(fallbackP.fingerprint).not.toBe(attributedP.fingerprint);
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/wire.test.ts`
Expected: FAIL — `Cannot find module '../../src/lifecycle/wire.js'` (the module does not exist yet).

- [ ] **Step 4: Implement `src/lifecycle/wire.ts`**

```typescript
/**
 * wire.ts — Fingerprint wiring for analysis outputs (lifecycle phase-2 bridge).
 *
 * Bridges the versioned finding-identity contract (fingerprint.ts) onto
 * al-perf's DetectedPattern[]: resolves each pattern's ANCHOR routine, derives
 * its FingerprintRoutineIdentity (stable when a confident alsem correlation
 * exists, fallback key otherwise), and stamps the canonical string-form
 * fingerprint onto the pattern.
 *
 * PURE — no I/O. Called by analyzeProfile (fallback identities, always) and
 * by fuseProfile (identity upgrade after correlation).
 *
 * ── ANCHOR POLICY (THE identity decision — decided once, here) ─────────────
 *
 * The anchor routine of a DetectedPattern is `involvedMethods[0]`, ALWAYS.
 * Two consumers anchoring differently would split identities, so no other
 * module may re-derive a pattern anchor.
 *
 * Verified against every detector (src/core/patterns.ts,
 * src/source/source-patterns.ts, src/source/source-only-patterns.ts):
 *  - single-method-dominance, recursive-call, and all 11 source detectors
 *    emit exactly one involved method — the subject.
 *  - high-hit-count (both variants) puts the hot child (the exploding
 *    callee) first.
 *  - event-chain puts the chain ROOT subscriber first.
 *  - repeated-siblings puts the PARENT first — the loop-owning call site,
 *    i.e. the routine whose change resolves the finding.
 *  - deep-call-stack / event-subscriber-hotspot are aggregate patterns whose
 *    lists are tree-traversal-ordered; [0] is a deterministic representative.
 *
 * Rejected alternative — "hottest involved method by selfTime": relative
 * heat is the least stable input across runs of the same scenario; anchoring
 * on it splits identities whenever two involved methods trade places.
 * Position 0 never depends on timing.
 *
 * Granularity (pinned by the v1 hash contract): identity =
 * (patternId × anchor routine × appId) with no salient location, so N
 * instances of one pattern on one routine share ONE fingerprint. The
 * lifecycle engine (phase 3) treats them as one finding with N occurrences.
 */

import { methodAttrKey } from "../semantic/correlate.js";
import type { MethodBreakdown } from "../types/aggregated.js";
import type { SemanticAttribution } from "../types/fused.js";
import type { DetectedPattern } from "../types/patterns.js";
import {
	computePatternFingerprint,
	type FingerprintRoutineIdentity,
	formatFingerprint,
	routineIdentityFromCorrelation,
} from "./fingerprint.js";

/** The resolved anchor of a pattern: routine identity + declaring appId. */
export interface PatternAnchor {
	identity: FingerprintRoutineIdentity;
	/** The anchor method's declaring appId ("" when unknown or unresolved). */
	appId: string;
}

/**
 * Index methods by their display label — the exact string the detectors write
 * into involvedMethods: `"<functionName> (<objectType> <objectId>)"`
 * (formatMethodRef in core/patterns.ts, methodLabel in source-patterns.ts,
 * memberLabel in source-only-patterns.ts — all three emit this format).
 * First write wins; method keys are unique after aggregation, so collisions
 * only occur for pathological synthetic input.
 */
export function buildMethodLabelMap(
	methods: MethodBreakdown[],
): Map<string, MethodBreakdown> {
	const map = new Map<string, MethodBreakdown>();
	for (const m of methods) {
		const label = `${m.functionName} (${m.objectType} ${m.objectId})`;
		if (!map.has(label)) map.set(label, m);
	}
	return map;
}

/**
 * Parse a display label back into identity fields. The first group is greedy
 * so only the LAST " (" starts the object suffix — function names may contain
 * spaces, dashes, and dots; object types are single tokens; ids are digits.
 */
const LABEL_RE = /^(.+) \((\S+) (\d+)\)$/;

/**
 * Resolve a pattern's anchor per the anchor policy (module header).
 *
 * Resolution ladder (every rung deterministic):
 *  1. involvedMethods[0] found in methodsByLabel → identity via
 *     routineIdentityFromCorrelation(attributions[methodAttrKey], method):
 *     stable when a confident correlation exists, fallback key otherwise.
 *     appId = method.appId ?? "".
 *  2. Label parseable but the method is not in the profile set → fallback key
 *     from the parsed (objectType, objectId, functionName), appId "".
 *  3. Label unparseable (or involvedMethods empty) → unkeyable-style fallback:
 *     objectType "", objectNumber 0, routine name = the raw label. Still
 *     deterministic — the same string always yields the same identity.
 */
export function resolvePatternAnchor(
	pattern: DetectedPattern,
	methodsByLabel: Map<string, MethodBreakdown>,
	attributions?: Map<string, SemanticAttribution>,
): PatternAnchor {
	const label = pattern.involvedMethods[0] ?? "";
	const method = methodsByLabel.get(label);
	if (method) {
		const attribution = attributions?.get(methodAttrKey(method));
		return {
			identity: routineIdentityFromCorrelation(attribution, method),
			appId: method.appId ?? "",
		};
	}
	const parsed = LABEL_RE.exec(label);
	if (parsed) {
		return {
			identity: routineIdentityFromCorrelation(undefined, {
				objectType: parsed[2],
				objectId: Number.parseInt(parsed[3], 10),
				functionName: parsed[1],
			}),
			appId: "",
		};
	}
	// Unkeyable-style fallback: a deterministic identity from the raw string.
	return {
		identity: routineIdentityFromCorrelation(undefined, {
			objectType: "",
			objectId: 0,
			functionName: label,
		}),
		appId: "",
	};
}

/**
 * Stamp `fingerprint` (canonical string form, `pattern:<16-hex>`) onto every
 * pattern IN PLACE. All 18 current detectors are routine-anchored, so no
 * salient location participates — identity survives line shifts by
 * construction (fingerprint.ts module header).
 *
 * Call sites:
 *  - analyzeProfile (core/analyzer.ts): no attributions → fallback keys.
 *    Runs ALWAYS (no source, no fusion required).
 *  - fuseProfile (semantic/fuse.ts): with attributions → re-mints, upgrading
 *    confidently-matched anchors to stable identities. Overwriting the
 *    analyzeProfile value is the ONE sanctioned overwrite (identity-upgrade
 *    semantics — see routineIdentityFromCorrelation).
 */
export function fingerprintPatterns(
	patterns: DetectedPattern[],
	methods: MethodBreakdown[],
	attributions?: Map<string, SemanticAttribution>,
): void {
	if (patterns.length === 0) return;
	const byLabel = buildMethodLabelMap(methods);
	for (const p of patterns) {
		const anchor = resolvePatternAnchor(p, byLabel, attributions);
		p.fingerprint = formatFingerprint(
			computePatternFingerprint(
				{ patternId: p.id },
				anchor.identity,
				anchor.appId,
			),
		);
	}
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `AI_DISABLED=1 bun test test/lifecycle/wire.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Verify the fingerprint contract tests still pass and types compile**

Run: `AI_DISABLED=1 bun test test/lifecycle/fingerprint.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Format and commit**

```bash
bunx biome check --write src/lifecycle/wire.ts src/types/patterns.ts test/lifecycle/wire.test.ts
git add src/lifecycle/wire.ts src/types/patterns.ts test/lifecycle/wire.test.ts
git commit -m "feat(lifecycle): anchor policy + pattern fingerprint wiring helpers

Anchor = involvedMethods[0], always — verified against all 18 detector
orderings; heat-based anchoring rejected (least stable input across runs).

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 2: Fingerprints in `analyzeProfile` + `meta.fingerprintAlgoVersion`

**Files:**
- Modify: `src/core/analyzer.ts` (analyzeProfile, ~line 303 and the `meta` literal ~line 344)
- Modify: `src/output/types.ts` (AnalysisResult.meta, ~line 45)
- Test: `test/core/analyzer.test.ts`, `test/cli/formatters/json.test.ts`

**Interfaces:**
- Consumes: `fingerprintPatterns(patterns, methods)` from Task 1; `FINGERPRINT_ALGO_VERSION` (= 1) from `src/lifecycle/fingerprint.ts`.
- Produces: every `AnalysisResult.patterns[i].fingerprint` is set (`pattern:<16-hex>`, fallback identities); `AnalysisResult.meta.fingerprintAlgoVersion === 1`. Task 3 relies on `analyzeProfile` having already stamped fallback fingerprints before any fusion runs.

- [ ] **Step 1: Write the failing tests**

Append to `test/core/analyzer.test.ts` (inside the file, as a new top-level `describe`; also add the import):

```typescript
import { FINGERPRINT_ALGO_VERSION } from "../../src/lifecycle/fingerprint.js";
```

```typescript
describe("analyzeProfile fingerprint wiring", () => {
	test("every detected pattern carries a canonical pattern: fingerprint", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		expect(result.patterns.length).toBeGreaterThan(0);
		for (const p of result.patterns) {
			expect(p.fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
		}
	});

	test("fingerprints are stable across two runs on the same profile", async () => {
		const a = await analyzeProfile(
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		const b = await analyzeProfile(
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		expect(a.patterns.map((p) => p.fingerprint)).toEqual(
			b.patterns.map((p) => p.fingerprint),
		);
	});

	test("meta carries the fingerprint algorithm version", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.meta.fingerprintAlgoVersion).toBe(FINGERPRINT_ALGO_VERSION);
	});
});
```

Append to `test/cli/formatters/json.test.ts` (inside `describe("formatAnalysisJson", ...)`):

```typescript
	test("passes pattern fingerprints and fingerprintAlgoVersion through verbatim", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/recursive-profile.alcpuprofile`,
		);
		expect(result.patterns.length).toBeGreaterThan(0);
		const parsed = JSON.parse(formatAnalysisJson(result));
		expect(parsed.meta.fingerprintAlgoVersion).toBe(1);
		expect(parsed.patterns[0].fingerprint).toBe(result.patterns[0].fingerprint);
		expect(parsed.patterns[0].fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `AI_DISABLED=1 bun test test/core/analyzer.test.ts test/cli/formatters/json.test.ts`
Expected: FAIL — `p.fingerprint` is `undefined` (does not match `/^pattern:/`), `meta.fingerprintAlgoVersion` is `undefined`.

- [ ] **Step 3: Add the meta field to the output type**

In `src/output/types.ts`, inside `AnalysisResult.meta`, after `confidenceFactors` (before `analyzedAt`), add:

```typescript
		/**
		 * The fingerprint algorithm version used to mint `patterns[].fingerprint`
		 * (and fusion finding fingerprints). Mirrors FINGERPRINT_ALGO_VERSION at
		 * analysis time (umbrella spec §4 — stored with every finding).
		 */
		fingerprintAlgoVersion?: number;
```

- [ ] **Step 4: Wire `analyzeProfile`**

In `src/core/analyzer.ts`:

Add imports (with the existing import block):

```typescript
import { FINGERPRINT_ALGO_VERSION } from "../lifecycle/fingerprint.js";
import { fingerprintPatterns } from "../lifecycle/wire.js";
```

After the existing lines (~303–304)

```typescript
	const nonIdleMethods = methods.filter((m) => !isIdle(m));
	options?.onAllMethods?.(nonIdleMethods);
```

insert:

```typescript
	// Lifecycle phase-2 wiring: mint a fingerprint for every detected pattern.
	// No fusion has run at this point, so identities use the fallback key —
	// fuseProfile re-mints with stable identities when a workspace fuses later.
	fingerprintPatterns(patterns, nonIdleMethods);
```

In the returned `meta` literal, before `analyzedAt: new Date().toISOString(),` add:

```typescript
			fingerprintAlgoVersion: FINGERPRINT_ALGO_VERSION,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `AI_DISABLED=1 bun test test/core/analyzer.test.ts test/cli/formatters/json.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm no formatter/section fallout (parity is compile-enforced)**

Run: `bunx tsc --noEmit && AI_DISABLED=1 bun test test/cli/formatters/`
Expected: no type errors; all formatter tests PASS (fields are additive, none rendered by terminal/markdown/html).

- [ ] **Step 7: Format and commit**

```bash
bunx biome check --write src/core/analyzer.ts src/output/types.ts test/core/analyzer.test.ts test/cli/formatters/json.test.ts
git add src/core/analyzer.ts src/output/types.ts test/core/analyzer.test.ts test/cli/formatters/json.test.ts
git commit -m "feat(analyze): mint fallback-key fingerprints on every detected pattern

patterns[].fingerprint + meta.fingerprintAlgoVersion — computed always,
source and fusion not required (graceful degradation).

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 3: Identity upgrade in `fuseProfile` (the fusion choke point)

**Files:**
- Modify: `src/semantic/fuse.ts` (fuseProfile body ~line 104, FuseOptions.patterns doc ~line 41)
- Test: `test/lifecycle/wire-fuse.integration.test.ts` (create)

**Interfaces:**
- Consumes: `fingerprintPatterns(patterns, methods, attributions)` from Task 1; the committed stub engine `test/fixtures/fusion/alsem-stub.ts` ("findings" mode emits `ProcessLine` + `OnRun` on Codeunit 50000, `ProcessLine` matched with a stableRoutineId) and workspace `test/fixtures/fusion/ws-min` — the same stub-launcher pattern as `test/semantic/corroborate.integration.test.ts`.
- Produces: after any successful `fuseProfile(methods, ws, { patterns })`, patterns anchored on confidently-matched routines carry stable-identity fingerprints. All five fusion paths (CLI analyze, compare after-only, MCP `analyze_profile`, MCP `prioritized_findings`, web) inherit this with zero per-site changes because each passes the same `patterns` array its result carries.

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/wire-fuse.integration.test.ts`:

```typescript
/**
 * wire-fuse.integration.test.ts — fuseProfile re-mints pattern fingerprints
 * with correlation attributions (lifecycle phase-2 identity upgrade).
 *
 * Uses the committed alsem-stub.ts in "findings" mode via a temp launcher,
 * mirroring test/semantic/corroborate.integration.test.ts. The stub's
 * inventory matches ProcessLine on Codeunit 50000 (single stableRoutineId),
 * so a pattern anchored there must upgrade fallback → stable identity.
 *
 * Also covers graceful degradation: a missing engine leaves the
 * analyzeProfile-minted fallback fingerprint untouched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
	computePatternFingerprint,
	formatFingerprint,
} from "../../src/lifecycle/fingerprint.js";
import { fingerprintPatterns } from "../../src/lifecycle/wire.js";
import { clearEngineCache } from "../../src/semantic/engine-runner.js";
import { fuseProfile } from "../../src/semantic/fuse.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { FusedModel } from "../../src/types/fused.js";
import type { DetectedPattern } from "../../src/types/patterns.js";

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/fusion");
const WS_MIN = resolve(FIXTURE_DIR, "ws-min");
const STUB_TS = resolve(FIXTURE_DIR, "alsem-stub.ts");
const BUN_EXE = process.execPath;

let cleanups: Array<() => void> = [];
afterEach(() => {
	clearEngineCache();
	for (const fn of cleanups) {
		try {
			fn();
		} catch {
			// ignore
		}
	}
	cleanups = [];
});

/** Platform-appropriate launcher for alsem-stub.ts in "findings" mode. */
function makeStubBinary(mode: "ok" | "findings" = "findings"): string {
	const tmpDir = mkdtempSync(join(tmpdir(), "al-perf-wire-fuse-stub-"));
	cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
	if (process.platform === "win32") {
		const cmdPath = join(tmpDir, "alsem-stub.cmd");
		writeFileSync(
			cmdPath,
			`@echo off\r\nset "ALSEM_STUB_MODE=${mode}"\r\n"${BUN_EXE}" "${STUB_TS}" %*\r\n`,
		);
		return cmdPath;
	}
	const shPath = join(tmpDir, "alsem-stub.sh");
	writeFileSync(
		shPath,
		`#!/bin/sh\nexport ALSEM_STUB_MODE='${mode}'\nexec "${BUN_EXE}" "${STUB_TS}" "$@"\n`,
	);
	chmodSync(shPath, 0o755);
	return shPath;
}

/** Methods matching the stub's "findings" mode inventory (no appId — stub app). */
function makeMethodBreakdowns(): MethodBreakdown[] {
	const base = {
		objectType: "Codeunit",
		objectName: "StubCodeunit",
		objectId: 50000,
		appName: "StubApp",
		calledBy: [],
		calls: [],
		costPerHit: 100,
		efficiencyScore: 1.0,
	};
	return [
		{
			...base,
			functionName: "ProcessLine",
			selfTime: 10000,
			selfTimePercent: 100,
			totalTime: 10000,
			totalTimePercent: 100,
			hitCount: 10,
		},
		{
			...base,
			functionName: "OnRun",
			selfTime: 0,
			selfTimePercent: 0,
			totalTime: 10000,
			totalTimePercent: 100,
			hitCount: 10,
		},
	];
}

function makePattern(): DetectedPattern {
	return {
		id: "repeated-siblings",
		severity: "critical",
		title: "ProcessLine repeated",
		description: "test",
		impact: 1000,
		involvedMethods: ["ProcessLine (Codeunit 50000)", "OnRun (Codeunit 50000)"],
		evidence: "test",
	};
}

function isFusedModel(result: unknown): result is FusedModel {
	return (
		typeof result === "object" &&
		result !== null &&
		"attributions" in result &&
		"correlationSummary" in result
	);
}

describe("fuseProfile fingerprint identity upgrade", () => {
	test("a matched anchor upgrades from the fallback to the stable-identity fingerprint", async () => {
		const stubBin = makeStubBinary("findings");
		const methods = makeMethodBreakdowns();
		const pattern = makePattern();

		// Pre-fusion state (what analyzeProfile mints): a fallback fingerprint.
		fingerprintPatterns([pattern], methods);
		const fallbackFp = pattern.fingerprint;
		expect(fallbackFp).toMatch(/^pattern:[0-9a-f]{16}$/);

		const result = await fuseProfile(methods, WS_MIN, {
			engine: stubBin,
			patterns: [pattern],
		});
		expect(isFusedModel(result)).toBe(true);
		if (!isFusedModel(result)) return;

		const attr = result.attributions.get("ProcessLine_Codeunit_50000");
		expect(attr?.status).toBe("matched");
		expect(typeof attr?.stableRoutineId).toBe("string");

		// Re-minted with the stable identity — different from the fallback,
		// and exactly reproducible from the attribution.
		expect(pattern.fingerprint).toMatch(/^pattern:[0-9a-f]{16}$/);
		expect(pattern.fingerprint).not.toBe(fallbackFp);
		const expected = formatFingerprint(
			computePatternFingerprint(
				{ patternId: "repeated-siblings" },
				{
					kind: "stable",
					stableRoutineId: attr?.stableRoutineId as string,
				},
				"",
			),
		);
		expect(pattern.fingerprint).toBe(expected);
	}, 30_000);

	test("a disabled engine leaves the fallback fingerprint untouched (graceful degradation)", async () => {
		const methods = makeMethodBreakdowns();
		const pattern = makePattern();
		fingerprintPatterns([pattern], methods);
		const fallbackFp = pattern.fingerprint;

		const result = await fuseProfile(methods, WS_MIN, {
			engine: "definitely-not-a-real-alsem-binary-xyz",
			patterns: [pattern],
		});

		expect("disabled" in result).toBe(true);
		expect(pattern.fingerprint).toBe(fallbackFp);
	}, 30_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `AI_DISABLED=1 bun test test/lifecycle/wire-fuse.integration.test.ts`
Expected: FAIL on the first test — `pattern.fingerprint` is unchanged after `fuseProfile` (`.not.toBe(fallbackFp)` fails). The disabled-engine test already passes (nothing touches the pattern yet).

- [ ] **Step 3: Implement the upgrade in `fuseProfile`**

In `src/semantic/fuse.ts`:

Add the import:

```typescript
import { fingerprintPatterns } from "../lifecycle/wire.js";
```

Replace the `FuseOptions.patterns` doc comment (lines 41–47) with:

```typescript
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
```

After `fused.allRoutines = engine.routines;` (line 104), add:

```typescript
	// Lifecycle phase-2 wiring: re-mint pattern fingerprints with the
	// correlation attributions, upgrading confidently-matched anchors from
	// fallback keys to stable routine identities (identity-upgrade semantics —
	// see routineIdentityFromCorrelation).
	if (opts?.patterns && opts.patterns.length > 0) {
		fingerprintPatterns(opts.patterns, methods, fused.attributions);
	}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `AI_DISABLED=1 bun test test/lifecycle/wire-fuse.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Confirm the existing fusion suites are unaffected**

Run: `AI_DISABLED=1 bun test test/semantic/`
Expected: PASS (corroboration, correlate, views, p4-wiring all green — the upgrade only adds a field to caller-owned pattern objects).

- [ ] **Step 6: Format and commit**

```bash
bunx biome check --write src/semantic/fuse.ts test/lifecycle/wire-fuse.integration.test.ts
git add src/semantic/fuse.ts test/lifecycle/wire-fuse.integration.test.ts
git commit -m "feat(fusion): upgrade pattern fingerprints to stable identities in fuseProfile

One choke point — CLI analyze, compare after-only, MCP, and web all pass
their result's patterns array into fuseProfile, so no per-site wiring.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 4: `alsem:` fingerprints on `PrioritizedFinding`

**Files:**
- Modify: `src/semantic/views.ts` (PrioritizedFinding type ~line 130; `toPrioritized` ~line 524; `toUnweighted` ~line 609)
- Test: `test/semantic/views.test.ts`

**Interfaces:**
- Consumes: `wrapAlsemFingerprint(native: string): FindingFingerprint` and `formatFingerprint` from `src/lifecycle/fingerprint.ts`; `FindingSummary.fingerprint` (the alsem-native value, always present per the contracts schema).
- Produces: every `PrioritizedFinding.fingerprint === "alsem:" + finding.fingerprint` — on weighted AND unweighted rows (cold/orphan/unkeyable findings need lifecycle identities too). `fusionViews.prioritizedFindings` / `unweightedFindings` carry it automatically in CLI, compare after-only, MCP, and web outputs.

- [ ] **Step 1: Write the failing tests**

Append to `test/semantic/views.test.ts` (a new top-level `describe`; the file's existing factories `makeMethod`, `makeRoutine`, `makeFinding`, `makeEngine`, and the `correlate` import are already in scope):

```typescript
describe("prioritizeFindings lifecycle fingerprints", () => {
	it("weighted rows carry the alsem:-wrapped native fingerprint", () => {
		const methods = [makeMethod("HotLeaf", "Codeunit", 50001, 80, 80)];
		const engine = makeEngine(
			[makeRoutine("HotLeaf", 50001, "Codeunit", "r1")],
			[makeFinding("FL", "fpL", "d1", "HotLeaf", "Codeunit", 50001)],
		);
		const fused = correlate(methods, engine);
		const { weighted } = prioritizeFindings(fused, methods);
		expect(weighted).toHaveLength(1);
		expect(weighted[0].fingerprint).toBe("alsem:fpL");
	});

	it("unweighted (cold) rows carry the alsem:-wrapped native fingerprint too", () => {
		const methods = [makeMethod("HotLeaf", "Codeunit", 50001, 80, 80)];
		const engine = makeEngine(
			[
				makeRoutine("HotLeaf", 50001, "Codeunit", "r1"),
				makeRoutine("ColdProc", 50002, "Codeunit", "r2"),
			],
			[makeFinding("FC", "fpC", "d1", "ColdProc", "Codeunit", 50002)],
		);
		const fused = correlate(methods, engine);
		const { unweighted } = prioritizeFindings(fused, methods);
		const cold = unweighted.find((r) => r.finding.id === "FC");
		expect(cold?.bucket).toBe("cold");
		expect(cold?.fingerprint).toBe("alsem:fpC");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `AI_DISABLED=1 bun test test/semantic/views.test.ts`
Expected: FAIL — `fingerprint` is `undefined` on both rows (property does not exist yet).

- [ ] **Step 3: Implement in `views.ts`**

Add the import:

```typescript
import {
	formatFingerprint,
	wrapAlsemFingerprint,
} from "../lifecycle/fingerprint.js";
```

In the `PrioritizedFinding` interface, after the `finding: FindingSummary;` field, add:

```typescript
	/**
	 * Canonical lifecycle identity in string form (`alsem:<native>`): the
	 * alsem-native fingerprint wrapped under the `alsem:` namespace
	 * (wrapAlsemFingerprint — passthrough, never re-hashed). Present on
	 * weighted AND unweighted rows so the lifecycle engine (phase 3) can track
	 * cold/orphan/unkeyable findings too.
	 */
	fingerprint?: string;
```

In `toPrioritized`, in the returned object literal, immediately after `finding: a.finding,` add:

```typescript
			fingerprint: formatFingerprint(wrapAlsemFingerprint(a.finding.fingerprint)),
```

In `toUnweighted`, in the returned object literal, immediately after `finding,` add:

```typescript
		fingerprint: formatFingerprint(wrapAlsemFingerprint(finding.fingerprint)),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `AI_DISABLED=1 bun test test/semantic/views.test.ts`
Expected: PASS (all existing views tests + the 2 new ones).

- [ ] **Step 5: Format and commit**

```bash
bunx biome check --write src/semantic/views.ts test/semantic/views.test.ts
git add src/semantic/views.ts test/semantic/views.test.ts
git commit -m "feat(views): alsem-namespaced fingerprints on prioritized findings

Weighted and unweighted rows both carry alsem:<native> — cold/orphan/
unkeyable findings need lifecycle identities too.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 5: `compareProfiles` comparability guard

**Files:**
- Modify: `src/core/analyzer.ts` (new exported helper + meta wiring in compareProfiles ~line 583)
- Modify: `src/output/types.ts` (ComparisonResult.meta, ~line 95)
- Test: `test/core/analyzer.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export function comparabilityWarning(
  	before: {
  		captureKind: "sampling" | "instrumentation";
  		sourceFormat?: "alcpuprofile" | "ir-json";
  	},
  	after: {
  		captureKind: "sampling" | "instrumentation";
  		sourceFormat?: "alcpuprofile" | "ir-json";
  	},
  ): string | undefined;
  ```
  and `ComparisonResult.meta.comparabilityWarning?: string` — absent when the profiles match (compare output byte-unchanged), present when captureKind or sourceFormat differ.

- [ ] **Step 1: Write the failing tests**

Append to `test/core/analyzer.test.ts` (add `comparabilityWarning` to the existing import from `../../src/core/analyzer.js`):

```typescript
describe("compareProfiles comparability guard", () => {
	test("flags sampling-vs-instrumentation comparisons", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/instrumentation-minimal.alcpuprofile`,
		);
		expect(result.meta.comparabilityWarning).toContain("capture kinds differ");
	});

	test("same capture kind and wire format → no warning field (byte-unchanged)", async () => {
		const result = await compareProfiles(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.meta.comparabilityWarning).toBeUndefined();
	});

	test("comparabilityWarning flags wire-format differences", () => {
		const warning = comparabilityWarning(
			{ captureKind: "instrumentation", sourceFormat: "ir-json" },
			{ captureKind: "instrumentation", sourceFormat: "alcpuprofile" },
		);
		expect(warning).toContain("wire formats differ");
	});

	test("comparabilityWarning treats an absent sourceFormat as alcpuprofile", () => {
		expect(
			comparabilityWarning(
				{ captureKind: "sampling" },
				{ captureKind: "sampling", sourceFormat: "alcpuprofile" },
			),
		).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `AI_DISABLED=1 bun test test/core/analyzer.test.ts`
Expected: FAIL — `comparabilityWarning` is not exported (SyntaxError on import), or once stubbed, `meta.comparabilityWarning` is `undefined` where a string is expected.

- [ ] **Step 3: Add the meta field to `ComparisonResult`**

In `src/output/types.ts`, inside `ComparisonResult.meta`, after `afterType`, add:

```typescript
		/**
		 * Present when the two profiles' capture kinds or wire formats differ —
		 * statistical sampling times and exact instrumentation times are never
		 * comparable (umbrella spec §4 baseline keying). Absent when they match,
		 * keeping matched-kind compare output byte-unchanged.
		 */
		comparabilityWarning?: string;
```

- [ ] **Step 4: Implement the helper and wire it into `compareProfiles`**

In `src/core/analyzer.ts`, above `compareProfiles`, add:

```typescript
/**
 * Comparability guard (umbrella spec §4): statistical sampling self-time and
 * exact instrumentation ticks are never comparable, and profiles from
 * different wire formats measure different things. Returns a warning string
 * when the two profiles' capture kinds or source formats differ; undefined
 * when they match (the field stays absent → compare output byte-unchanged).
 *
 * Exported for unit testing and library use.
 */
export function comparabilityWarning(
	before: {
		captureKind: "sampling" | "instrumentation";
		sourceFormat?: "alcpuprofile" | "ir-json";
	},
	after: {
		captureKind: "sampling" | "instrumentation";
		sourceFormat?: "alcpuprofile" | "ir-json";
	},
): string | undefined {
	const beforeFormat = before.sourceFormat ?? "alcpuprofile";
	const afterFormat = after.sourceFormat ?? "alcpuprofile";
	const parts: string[] = [];
	if (before.captureKind !== after.captureKind) {
		parts.push(
			`capture kinds differ (${before.captureKind} vs ${after.captureKind}) — statistical sampling times and exact instrumentation times are not comparable`,
		);
	}
	if (beforeFormat !== afterFormat) {
		parts.push(`wire formats differ (${beforeFormat} vs ${afterFormat})`);
	}
	if (parts.length === 0) return undefined;
	return `before/after profiles are not directly comparable: ${parts.join("; ")}. Deltas may be misleading.`;
}
```

In `compareProfiles`, immediately before the `const baseResult: ComparisonResult = {` literal (~line 583), add:

```typescript
	const comparability = comparabilityWarning(
		{
			captureKind: beforeProcessed.type,
			sourceFormat: beforeProcessed.sourceFormat,
		},
		{
			captureKind: afterProcessed.type,
			sourceFormat: afterProcessed.sourceFormat,
		},
	);
```

and in the `meta` literal, after `afterType: afterProcessed.type,`, add:

```typescript
			...(comparability !== undefined
				? { comparabilityWarning: comparability }
				: {}),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `AI_DISABLED=1 bun test test/core/analyzer.test.ts`
Expected: PASS (all existing analyzer tests + the 4 new ones).

- [ ] **Step 6: Format and commit**

```bash
bunx biome check --write src/core/analyzer.ts src/output/types.ts test/core/analyzer.test.ts
git add src/core/analyzer.ts src/output/types.ts test/core/analyzer.test.ts
git commit -m "feat(compare): comparability warning for mixed capture kinds/formats

meta.comparabilityWarning set when captureKind or sourceFormat differ;
absent (byte-unchanged) when they match. Umbrella spec section 4.

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 6: Library exports + full verification

**Files:**
- Modify: `src/index.ts`
- Test: full-suite verification (no new test file — `tsc` enforces export correctness, the suite guards regressions)

**Interfaces:**
- Produces (public library surface): the fingerprint contract (`FINGERPRINT_ALGO_VERSION`, `computePatternFingerprint`, `computeTelemetryFingerprint`, `formatFingerprint`, `linkFingerprints`, `normalizeSalientLocation`, `routineIdentityFromCorrelation`, `wrapAlsemFingerprint` + all its types), the wiring helpers (`buildMethodLabelMap`, `fingerprintPatterns`, `resolvePatternAnchor`, `PatternAnchor`), and `comparabilityWarning`. The phase-3 lifecycle plan and external consumers import these from `al-perf`.

- [ ] **Step 1: Add the exports**

In `src/index.ts`:

Change the analyzer export line to include the new helper:

```typescript
export {
	analyzeProfile,
	comparabilityWarning,
	compareProfiles,
} from "./core/analyzer.js";
```

After the `HistoryStore` export block (module paths are ordered roughly alphabetically: history < lifecycle < mcp), add:

```typescript
// Lifecycle (phase 2) — finding-identity contract + fingerprint wiring
export type {
	CaptureKind,
	FindingFingerprint,
	FingerprintMigration,
	FingerprintMigrationReason,
	FingerprintNamespace,
	FingerprintRoutineIdentity,
	PatternFingerprintInput,
	SalientLocation,
	TelemetryFingerprintInput,
} from "./lifecycle/fingerprint.js";
export {
	computePatternFingerprint,
	computeTelemetryFingerprint,
	FINGERPRINT_ALGO_VERSION,
	formatFingerprint,
	linkFingerprints,
	normalizeSalientLocation,
	routineIdentityFromCorrelation,
	wrapAlsemFingerprint,
} from "./lifecycle/fingerprint.js";
export type { PatternAnchor } from "./lifecycle/wire.js";
export {
	buildMethodLabelMap,
	fingerprintPatterns,
	resolvePatternAnchor,
} from "./lifecycle/wire.js";
```

- [ ] **Step 2: Type-check (compile-enforced formatter parity + export validity)**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint/format check**

Run: `bunx biome check .`
Expected: clean (run `bunx biome check --write .` first if it reports fixable issues).

- [ ] **Step 4: Run the full test suite**

Run: `AI_DISABLED=1 bun test`
Expected: ALL tests PASS — including the untouched terminal/markdown/html formatter suites (additive fields are not rendered), MCP suites, and the fusion suites.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(lifecycle): export fingerprint contract + wiring on library surface

Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

## Self-Review (performed while writing this plan)

1. **Scope coverage against the phase brief:**
   - Anchor policy decided, documented (plan + wire.ts module header), implemented as pure helpers with graceful string-fallback → Task 1. ✓
   - Fingerprints computed ALWAYS in `analyzeProfile` (fallback keys, no source needed); fusion findings get `alsem:`-wrapped fingerprints; `meta.fingerprintAlgoVersion` → Tasks 2 & 4; identity upgrade when fusion runs → Task 3. ✓
   - compareProfiles captureKind/sourceFormat guard → Task 5. ✓
   - Tests: per-detector anchor ordering verified in the policy table; stability across runs (Task 2); fallback-vs-attributed divergence (Tasks 1 & 3); JSON passthrough assertion (Task 2); terminal/markdown/html untouched with parity verified by `tsc` + full formatter suite (Tasks 2 & 6). ✓
   - Exports → Task 6. ✓
   - Out-of-scope items (storage, states, sinks, telemetry, human-formatter rendering) not planned. ✓
2. **Placeholder scan:** every code step contains complete code; every run step has an exact command and expected outcome; no TBDs, no "similar to Task N". ✓
3. **Type consistency:** `fingerprintPatterns(patterns, methods, attributions?)` used identically in Tasks 1, 2, 3; `PatternAnchor { identity, appId }` consistent; `comparabilityWarning` signature matches its test usage; `PrioritizedFinding.fingerprint` naming matches `DetectedPattern.fingerprint`. Import paths use the repo's `.js`-suffix ESM convention throughout. ✓
4. **Known deliberate behaviors (documented, not bugs):** N same-pattern instances on one routine share a fingerprint (v1 contract granularity); fallback and stable identities for the same routine deliberately diverge until a phase-3 `identity-upgrade` migration links them; MCP `prioritized_findings` re-fingerprints a discarded pattern array (harmless); compare's after-only tier upgrades local `afterPatterns` that are never emitted (harmless).
