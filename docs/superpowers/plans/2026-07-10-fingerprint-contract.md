# Finding Fingerprint Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone, versioned finding-identity contract (`src/lifecycle/fingerprint.ts`) — pure types + functions that mint stable, namespaced fingerprints for pattern, alsem, and telemetry findings, consumed by fusion output types (phase 2) and the lifecycle engine (phase 3).

**Architecture:** One new pure module under `src/lifecycle/` with one test file. It reuses the existing identity-normalization helpers from `src/semantic/identity.ts` (canonicalObjectType, normalizeTriggerName, normalizeAppGuid) so the fingerprint key can never drift from the correlation join key. No storage, no I/O, no subprocess calls — hashing via `node:crypto` sha256, hex-truncated to 16 chars.

**Tech Stack:** Bun + TypeScript, `bun:test`, `node:crypto` (no new dependencies), biome formatting (tabs, double quotes).

## Global Constraints

- **Pure functions only** — no I/O, no filesystem, no storage, no subprocess calls (same discipline as `src/semantic/correlate.ts`).
- **No new dependencies** — hashing uses `node:crypto` `createHash("sha256")` only.
- **`FINGERPRINT_ALGO_VERSION = 1`** — stored on every fingerprint; spec (umbrella §4): "`fingerprintAlgoVersion` is stored with every finding."
- **Namespaces never collide across origins** (umbrella §4): `alsem:` (native passthrough), `pattern:<hash>`, `telemetry:<hash>`.
- **Ambiguous correlation matches never mint stableRoutineId-based fingerprints** (umbrella §3/§4) — they use the fallback key.
- **Profile-only findings are ALWAYS fingerprintable** (umbrella §4) — fallback key `(appId, canonicalObjectType, objectNumber, normalizedRoutineName)`, tolerant of a missing appId.
- **Salient location is capture-kind-independent**: normalized to 1-based display lines; ir-json wire lines are 0-based (+1 to display), `.alcpuprofile` lines are already display lines (umbrella §4).
- **Style**: tabs, double quotes, `.js` extensions on relative imports, doc-comment style of `src/semantic/contracts.ts` (module header explaining the contract; JSDoc on every export).
- **TDD**: every task writes the failing test first, runs it, implements, re-runs, commits. Test command: `bun test test/lifecycle/fingerprint.test.ts`.
- **`bunx tsc --noEmit` must pass before every commit.**
- Commits are conventional-commit style and every commit message ends with the trailer line:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`

---

## Design Decisions (contract ambiguities resolved here — read before implementing)

These are binding for all tasks. Each records *why* so a reviewer can challenge the reasoning, not guess at it.

1. **Type name `FingerprintRoutineIdentity`, not `RoutineIdentity`.** `RoutineIdentity` already exists in `src/semantic/contracts.ts:47` (the alsem inventory entry). Lifecycle code will import both types side by side; a same-name type with a different meaning in the same codebase is a maintenance hazard. The union is therefore named `FingerprintRoutineIdentity`.

2. **`FindingFingerprint.value` is the BARE hash (or native alsem fingerprint) with no namespace prefix.** The canonical string form `"<namespace>:<hash-or-native>"` is produced by `formatFingerprint()`. Rationale: keeping `value` bare makes double-prefix bugs (`"alsem:alsem:x"` on re-wrap) impossible, and the namespace is already a structured field.

3. **Line is NOT part of the salient location for routine-anchored patterns — which is ALL 18 current detectors.** `DetectedPattern` (`src/types/patterns.ts`) carries no per-site location (`involvedMethods` is routine-level strings), so there is nothing site-level to distinguish anyway. More importantly, lifecycle stability dominates: an unrelated one-line edit above a loop must not resolve-and-refile the finding. Cost accepted: if a future detector fires twice in one routine, both sites collapse to one finding — acceptable because severity/impact updates flow through the same finding, and a future site-anchored detector can opt in by passing a `salientLocation`. The `salientLocation` parameter exists NOW (with the exact normalization rule) so the hash-input shape never changes when site-anchored patterns arrive.

4. **`CaptureKind = "alcpuprofile" | "ir-json"`** — named by wire format, not capture technique, because the line-base convention is a property of the serialization format (ir-json is 0-based on the wire regardless of how it was captured; `.alcpuprofile` carries 1-based display lines).

5. **Telemetry fingerprints include a required `signalId`** (e.g. `"RT0018"`). The task sketch listed only `(appId + objectType + objectNumber + routineName)`, but without a signal discriminator a long-running-AL finding (RT0018) and a long-running-SQL finding (RT0005) on the same routine would collapse into one lifecycle identity — plainly wrong. `signalId` plays the same role `patternId` plays for pattern fingerprints.

6. **Fallback-key normalization**: `appId` via `normalizeAppGuid` (dash-less lowercase; `""` when absent), `objectType` via `canonicalObjectType`, routine name via `normalizeTriggerName(...)` then `.toLowerCase()`. The lowercase step goes beyond the correlation join key (which is case-sensitive on routine name) because AL identifiers are case-insensitive and different producers (`.alcpuprofile` vs ir-json vs telemetry) may disagree on casing — a fingerprint must not split on casing drift.

7. **Hash input**: sha256 over tokens joined with `"\u001f"` (ASCII unit separator — cannot appear in AL identifiers or GUIDs), first 16 hex chars (64 bits — ample for per-tenant finding counts). Token order is fixed and documented; the first token is `"v1"` (the algo version) and the second is the domain (`"pattern"` / `"telemetry"`), so cross-domain and cross-version raw-hash collisions are structurally impossible even before the namespace prefix.

8. **Migration reasons**: `"algo-upgrade"` (default; guards: same namespace, strictly increasing algoVersion), `"identity-upgrade"` (fallback-key finding linked to its stableRoutineId identity after source registration — umbrella §4: "a migration pass links fallback-key findings to their stableRoutineId identities"; guard: same namespace), `"manual-merge"` (the rename-severs-stableRoutineId mitigation from umbrella §4; no namespace guard). Linking an identity to itself throws.

9. **`matched` with an ARRAY `stableRoutineId` never mints a stable identity** (defensive — `SemanticAttribution.stableRoutineId` is `string | string[]`; the array form belongs to `ambiguous`, but the type permits it on `matched`, so guard on `typeof === "string"`).

10. **Absent `appId` hashes as the empty segment** — a profile-only method with no `declaringApplication.appId` still gets a deterministic fingerprint (the spec's "profile-only findings are ALWAYS fingerprintable" wins over key completeness).

## File Structure

| File | Responsibility |
|---|---|
| `src/lifecycle/fingerprint.ts` (create) | The entire contract: version constant, types, salient-location normalization, the three fingerprint constructors, correlation→identity adapter, migration links. One file — it is one contract, versioned as one unit. |
| `test/lifecycle/fingerprint.test.ts` (create) | All unit tests, one `describe` block per export, following `test/semantic/identity.test.ts` conventions (bun:test, `.js` imports, header comment listing coverage). |

No existing files are modified. Consumed (read-only) existing interfaces:

- `src/semantic/identity.ts` — `canonicalObjectType(s: string): string`, `normalizeTriggerName(functionName: string): string`, `normalizeAppGuid(id: string | undefined): string`
- `src/types/fused.ts` — `SemanticAttribution` (fields used: `status: "matched" | "ambiguous" | "blind-spot"`, `stableRoutineId?: string | string[]`)

---

### Task 1: Module skeleton — types, version constant, salient-location normalization

**Files:**
- Create: `src/lifecycle/fingerprint.ts`
- Create: `test/lifecycle/fingerprint.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (first task).
- Produces (later tasks rely on these exact names):
  - `const FINGERPRINT_ALGO_VERSION = 1`
  - `type FingerprintNamespace = "alsem" | "pattern" | "telemetry"`
  - `interface FindingFingerprint { value: string; namespace: FingerprintNamespace; algoVersion: number }`
  - `type CaptureKind = "alcpuprofile" | "ir-json"`
  - `interface SalientLocation { file?: string; line?: number }`
  - `type FingerprintRoutineIdentity = { kind: "stable"; stableRoutineId: string } | { kind: "fallback"; appId: string; canonicalObjectType: string; objectNumber: number; normalizedRoutineName: string }`
  - `function normalizeSalientLocation(location: { file?: string; line?: number }, captureKind: CaptureKind): SalientLocation`

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/fingerprint.test.ts` with exactly this content:

```typescript
/**
 * fingerprint.test.ts — Unit tests for src/lifecycle/fingerprint.ts
 *
 * Covers:
 *  - FINGERPRINT_ALGO_VERSION pin
 *  - normalizeSalientLocation: capture-kind line-base normalization
 *    (ir-json wire 0-based → display 1-based; .alcpuprofile passthrough),
 *    path normalization, invalid-line handling
 *  - computePatternFingerprint: determinism, namespace/version stamping,
 *    stable-vs-fallback divergence, line-shift stability (routine-anchored)
 *  - wrapAlsemFingerprint / computeTelemetryFingerprint: passthrough,
 *    coarse key, namespace non-collision
 *  - routineIdentityFromCorrelation: matched→stable, ambiguous NEVER stable,
 *    fallback normalization
 *  - linkFingerprints: migration records + guards
 */

import { describe, expect, it } from "bun:test";
import {
	FINGERPRINT_ALGO_VERSION,
	normalizeSalientLocation,
} from "../../src/lifecycle/fingerprint.js";

// ---------------------------------------------------------------------------
// FINGERPRINT_ALGO_VERSION
// ---------------------------------------------------------------------------

describe("FINGERPRINT_ALGO_VERSION", () => {
	it("is pinned to 1", () => {
		expect(FINGERPRINT_ALGO_VERSION).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// normalizeSalientLocation
// ---------------------------------------------------------------------------

describe("normalizeSalientLocation", () => {
	it("converts an ir-json wire line (0-based) to a display line (+1)", () => {
		const loc = normalizeSalientLocation({ line: 41 }, "ir-json");
		expect(loc.line).toBe(42);
	});

	it("passes an .alcpuprofile display line through unchanged", () => {
		const loc = normalizeSalientLocation({ line: 42 }, "alcpuprofile");
		expect(loc.line).toBe(42);
	});

	it("capture-kind equivalence: wire line N equals display line N+1", () => {
		const fromWire = normalizeSalientLocation(
			{ file: "src\\SalesPost.Codeunit.al", line: 41 },
			"ir-json",
		);
		const fromDisplay = normalizeSalientLocation(
			{ file: "src/salespost.codeunit.al", line: 42 },
			"alcpuprofile",
		);
		expect(fromWire).toEqual(fromDisplay);
	});

	it("ir-json wire line 0 is valid and becomes display line 1", () => {
		const loc = normalizeSalientLocation({ line: 0 }, "ir-json");
		expect(loc.line).toBe(1);
	});

	it("normalizes file paths: backslashes → forward slashes, lowercased", () => {
		const loc = normalizeSalientLocation(
			{ file: "Src\\App\\SalesPost.Codeunit.AL", line: 1 },
			"alcpuprofile",
		);
		expect(loc.file).toBe("src/app/salespost.codeunit.al");
	});

	it("drops a non-positive .alcpuprofile display line (line 0 = unknown)", () => {
		expect(
			normalizeSalientLocation({ line: 0 }, "alcpuprofile").line,
		).toBeUndefined();
	});

	it("drops a negative ir-json wire line", () => {
		expect(normalizeSalientLocation({ line: -1 }, "ir-json").line).toBeUndefined();
	});

	it("drops a non-integer line", () => {
		expect(
			normalizeSalientLocation({ line: 41.5 }, "ir-json").line,
		).toBeUndefined();
	});

	it("omits file when absent or empty", () => {
		expect(normalizeSalientLocation({ line: 1 }, "alcpuprofile").file).toBeUndefined();
		expect(
			normalizeSalientLocation({ file: "", line: 1 }, "alcpuprofile").file,
		).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/lifecycle/fingerprint.test.ts`
Expected: FAIL — `Cannot find module '../../src/lifecycle/fingerprint.js'` (the module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/lifecycle/fingerprint.ts` with exactly this content:

```typescript
/**
 * fingerprint.ts — Versioned finding-identity contract (lifecycle pre-phase).
 *
 * The single source of truth for how a finding is identified across the
 * platform (umbrella spec §4 "Finding identity"). Consumed by the fusion
 * output types (phase 2) and the lifecycle engine (phase 3).
 *
 * PURE — no I/O, no storage, no subprocess calls. Types + functions only.
 *
 * Namespaces (identities NEVER collide across origins):
 *   alsem:<native>    — alsem-originated findings keep their native
 *                       fingerprint verbatim (passthrough, never re-hashed).
 *   pattern:<hash>    — al-perf pattern detections (sha256, 16 hex chars).
 *   telemetry:<hash>  — coarse routine-level telemetry signals (RT0018 …).
 *
 * Pattern fingerprint = sha256 over (algoVersion, "pattern", patternId,
 * appId, routine identity, salient location). Routine identity is the alsem
 * `stableRoutineId` when a CONFIDENT correlation exists (status="matched"
 * with a single id), else the fallback key
 * (appId, canonicalObjectType, objectNumber, normalizedRoutineName) — so
 * profile-only findings (the common case before source registration) are
 * ALWAYS fingerprintable. Ambiguous correlations NEVER mint
 * stableRoutineId-based fingerprints.
 *
 * Salient-location convention: 1-based DISPLAY lines. ir-json wire lines are
 * 0-based and get +1; `.alcpuprofile` lines are already display lines.
 * Routine-anchored patterns (all 18 current detectors) carry NO salient
 * location — their identity survives line shifts by construction. Only a
 * future site-anchored detector opts in by passing a normalized location.
 *
 * Every fingerprint carries `algoVersion` (= FINGERPRINT_ALGO_VERSION at mint
 * time). Algorithm upgrades produce `FingerprintMigration` records via
 * `linkFingerprints` — the lifecycle store (phase 3) applies them; this
 * module only defines the record.
 *
 * KNOWN LIMITATION: renaming a routine or changing its signature severs
 * `stableRoutineId` — the old finding silently resolves and a duplicate is
 * filed under the new identity. Mitigations (phase 3): alsem's differential
 * machinery as rename-detection prior art, plus a manual fingerprint-merge
 * operation (`linkFingerprints` with reason "manual-merge") exposed via
 * `findings_update`.
 */

// ---------------------------------------------------------------------------
// Version constant (the contract pin)
// ---------------------------------------------------------------------------

/**
 * The fingerprint algorithm version stamped on every minted fingerprint.
 * Bump when the hash inputs, token order, normalization rules, or truncation
 * length change — and ship a re-fingerprint migration (linkFingerprints).
 */
export const FINGERPRINT_ALGO_VERSION = 1;

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** The three identity origins. Prefixed onto the string form — never collide. */
export type FingerprintNamespace = "alsem" | "pattern" | "telemetry";

/**
 * A namespaced finding identity.
 *
 * `value` is the BARE hash (pattern/telemetry) or the native alsem
 * fingerprint — it never contains the namespace prefix. The canonical string
 * form `"<namespace>:<value>"` is produced by `formatFingerprint`.
 */
export interface FindingFingerprint {
	value: string;
	namespace: FingerprintNamespace;
	algoVersion: number;
}

/**
 * The wire format a location came from. The line-base convention is a
 * property of the serialization format:
 *  - "alcpuprofile" — 1-based display lines (Microsoft's profile format).
 *  - "ir-json"      — 0-based wire lines (bc-mdc-converter interchange IR).
 */
export type CaptureKind = "alcpuprofile" | "ir-json";

/**
 * A normalized, capture-kind-independent source location.
 * Produced ONLY by `normalizeSalientLocation` — never construct by hand.
 */
export interface SalientLocation {
	/** Normalized path: forward slashes, lowercased. Absent when unknown. */
	file?: string;
	/** 1-based display line. Absent when unknown/invalid. */
	line?: number;
}

/**
 * The routine identity that anchors a pattern fingerprint.
 *
 *  - "stable"   — a confident alsem correlation exists; the alsem
 *                 `stableRoutineId` (colon form
 *                 `<appGuid>:<objectType>:<objectNumber>#<hash>`) is the
 *                 identity. Survives line shifts and file moves; severed by
 *                 rename/signature change (see module header).
 *  - "fallback" — no confident correlation (profile-only, ambiguous,
 *                 blind-spot, cold, unkeyable). All fields pre-normalized:
 *                 appId dash-less lowercase ("" when unknown), objectType in
 *                 canonical AL-keyword case, routine name trigger-normalized
 *                 and lowercased (AL identifiers are case-insensitive).
 *
 * NOTE: named FingerprintRoutineIdentity (not RoutineIdentity) to avoid
 * colliding with the alsem inventory type in src/semantic/contracts.ts.
 */
export type FingerprintRoutineIdentity =
	| { kind: "stable"; stableRoutineId: string }
	| {
			kind: "fallback";
			appId: string;
			canonicalObjectType: string;
			objectNumber: number;
			normalizedRoutineName: string;
	  };

// ---------------------------------------------------------------------------
// normalizeSalientLocation
// ---------------------------------------------------------------------------

/**
 * Normalize a raw location to the capture-kind-independent convention.
 *
 * Line rule (THE contract): output is a 1-based display line.
 *  - "ir-json"      → wire line + 1 (wire lines are 0-based; wire 0 = display 1).
 *  - "alcpuprofile" → unchanged (already display lines).
 * A line that is missing, non-integer, or would normalize to < 1 (e.g. the
 * `.alcpuprofile` "line 0 = unknown" convention) is dropped (undefined).
 *
 * File rule: backslashes → forward slashes, lowercased (AL projects live on
 * case-insensitive filesystems; casing must not split identities). Empty or
 * missing → undefined.
 */
export function normalizeSalientLocation(
	location: { file?: string; line?: number },
	captureKind: CaptureKind,
): SalientLocation {
	const file = location.file
		? location.file.replace(/\\/g, "/").toLowerCase()
		: undefined;

	let line: number | undefined;
	if (location.line !== undefined && Number.isInteger(location.line)) {
		const display =
			captureKind === "ir-json" ? location.line + 1 : location.line;
		line = display >= 1 ? display : undefined;
	}

	return { file, line };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/lifecycle/fingerprint.test.ts`
Expected: PASS — 10 tests (1 version pin + 9 normalization tests), 0 fail.

- [ ] **Step 5: Type-check and commit**

Run: `bunx tsc --noEmit` — expected: no output, exit 0.

```bash
git add src/lifecycle/fingerprint.ts test/lifecycle/fingerprint.test.ts
git commit -m "feat(lifecycle): fingerprint contract types + salient-location normalization" -m "Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 2: Pattern fingerprint hashing + string form

**Files:**
- Modify: `src/lifecycle/fingerprint.ts` (append after `normalizeSalientLocation`)
- Modify: `test/lifecycle/fingerprint.test.ts` (extend imports; append describe blocks)

**Interfaces:**
- Consumes (Task 1): `FINGERPRINT_ALGO_VERSION`, `FindingFingerprint`, `FingerprintNamespace`, `SalientLocation`, `FingerprintRoutineIdentity`, `normalizeSalientLocation(location, captureKind)`.
- Produces:
  - `function formatFingerprint(fp: FindingFingerprint): string` — returns `` `${fp.namespace}:${fp.value}` ``
  - `interface PatternFingerprintInput { patternId: string; salientLocation?: SalientLocation }`
  - `function computePatternFingerprint(pattern: PatternFingerprintInput, identity: FingerprintRoutineIdentity, appId: string): FindingFingerprint`

- [ ] **Step 1: Write the failing test**

In `test/lifecycle/fingerprint.test.ts`, extend the import block to:

```typescript
import {
	FINGERPRINT_ALGO_VERSION,
	type FingerprintRoutineIdentity,
	computePatternFingerprint,
	formatFingerprint,
	normalizeSalientLocation,
} from "../../src/lifecycle/fingerprint.js";
```

Append at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// computePatternFingerprint / formatFingerprint
// ---------------------------------------------------------------------------

/** A pre-normalized fallback identity used across the fingerprint tests. */
const FALLBACK_ID: FingerprintRoutineIdentity = {
	kind: "fallback",
	appId: "437dbf0e84ff417a965ded2bb9650972",
	canonicalObjectType: "Codeunit",
	objectNumber: 50100,
	normalizedRoutineName: "processrecords",
};

/** A stable identity for the SAME routine (confident alsem match). */
const STABLE_ID: FingerprintRoutineIdentity = {
	kind: "stable",
	stableRoutineId:
		"437dbf0e-84ff-417a-965d-ed2bb9650972:Codeunit:50100#a1b2c3d4",
};

const APP_ID = "437dbf0e-84ff-417a-965d-ed2bb9650972";

describe("computePatternFingerprint", () => {
	it("is deterministic: identical inputs → identical fingerprints", () => {
		const a = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const b = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(a).toEqual(b);
	});

	it("emits a 16-char lowercase hex value", () => {
		const fp = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(fp.value).toMatch(/^[0-9a-f]{16}$/);
	});

	it("stamps namespace 'pattern' and the current algo version", () => {
		const fp = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(fp.namespace).toBe("pattern");
		expect(fp.algoVersion).toBe(FINGERPRINT_ALGO_VERSION);
	});

	it("stable identity vs fallback identity for the SAME routine diverge", () => {
		// Until a migration links them, these are distinct identities by design.
		const viaFallback = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const viaStable = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			STABLE_ID,
			APP_ID,
		);
		expect(viaFallback.value).not.toBe(viaStable.value);
	});

	it("different patternId on the same routine → different fingerprints", () => {
		const a = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const b = computePatternFingerprint(
			{ patternId: "modify-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(a.value).not.toBe(b.value);
	});

	it("different appId → different fingerprints", () => {
		const a = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const b = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			"11111111-2222-3333-4444-555555555555",
		);
		expect(a.value).not.toBe(b.value);
	});

	it("dashed and dash-less appId forms normalize to the same fingerprint", () => {
		const dashed = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			"437dbf0e-84ff-417a-965d-ed2bb9650972",
		);
		const dashless = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			"437DBF0E84FF417A965DED2BB9650972",
		);
		expect(dashed.value).toBe(dashless.value);
	});

	it("line-shift stability: routine-anchored patterns carry no location, so shifted source lines cannot change identity", () => {
		// The contract for loop-type / routine-anchored patterns (all 18 current
		// detectors): salientLocation is OMITTED. The same finding before and
		// after an unrelated edit shifts every line — identity must not change.
		const before = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const after = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(before.value).toBe(after.value);
	});

	it("a provided salient location DOES participate in the hash", () => {
		const without = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		const withLoc = computePatternFingerprint(
			{
				patternId: "calcfields-in-loop",
				salientLocation: normalizeSalientLocation(
					{ file: "src/SalesPost.Codeunit.al", line: 42 },
					"alcpuprofile",
				),
			},
			FALLBACK_ID,
			APP_ID,
		);
		expect(without.value).not.toBe(withLoc.value);
	});

	it("capture-kind equivalence at the hash level: wire line N ≡ display line N+1", () => {
		const fromWire = computePatternFingerprint(
			{
				patternId: "calcfields-in-loop",
				salientLocation: normalizeSalientLocation(
					{ file: "src/SalesPost.Codeunit.al", line: 41 },
					"ir-json",
				),
			},
			FALLBACK_ID,
			APP_ID,
		);
		const fromDisplay = computePatternFingerprint(
			{
				patternId: "calcfields-in-loop",
				salientLocation: normalizeSalientLocation(
					{ file: "src/SalesPost.Codeunit.al", line: 42 },
					"alcpuprofile",
				),
			},
			FALLBACK_ID,
			APP_ID,
		);
		expect(fromWire.value).toBe(fromDisplay.value);
	});
});

describe("formatFingerprint", () => {
	it("renders the canonical '<namespace>:<value>' string form", () => {
		const fp = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			FALLBACK_ID,
			APP_ID,
		);
		expect(formatFingerprint(fp)).toBe(`pattern:${fp.value}`);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/lifecycle/fingerprint.test.ts`
Expected: FAIL — `Export named 'computePatternFingerprint' not found` (or equivalent missing-export error). Task 1's 10 tests still pass.

- [ ] **Step 3: Write the implementation**

Append to `src/lifecycle/fingerprint.ts` (after `normalizeSalientLocation`; add the `node:crypto` and identity imports at the TOP of the file, below the module doc comment):

At the top of the file (first imports):

```typescript
import { createHash } from "node:crypto";
import { normalizeAppGuid } from "../semantic/identity.js";
```

Appended after `normalizeSalientLocation`:

```typescript
// ---------------------------------------------------------------------------
// String form
// ---------------------------------------------------------------------------

/**
 * The canonical string form: `"<namespace>:<hash-or-native>"`.
 * This is the key the lifecycle store (phase 3) and sinks use.
 */
export function formatFingerprint(fp: FindingFingerprint): string {
	return `${fp.namespace}:${fp.value}`;
}

// ---------------------------------------------------------------------------
// Hashing (internal)
//
// Token contract (v1): tokens are joined with "\u001f" (ASCII unit separator
// — cannot occur in AL identifiers, GUIDs, or paths) and sha256-hashed,
// truncated to the first 16 hex chars. The first token is the algo version
// ("v1"), the second the domain ("pattern"/"telemetry"), so raw hashes can
// never collide across versions or domains even before namespacing.
// ---------------------------------------------------------------------------

const TOKEN_SEP = "\u001f";

function sha256Hex16(tokens: readonly string[]): string {
	return createHash("sha256")
		.update(tokens.join(TOKEN_SEP))
		.digest("hex")
		.slice(0, 16);
}

/** Deterministic token expansion of a routine identity (kind-prefixed). */
function identityTokens(identity: FingerprintRoutineIdentity): string[] {
	if (identity.kind === "stable") {
		return ["sid", identity.stableRoutineId];
	}
	return [
		"fk",
		identity.appId,
		identity.canonicalObjectType,
		String(identity.objectNumber),
		identity.normalizedRoutineName,
	];
}

/** Deterministic token expansion of a salient location (absent → empty). */
function locationTokens(location: SalientLocation | undefined): string[] {
	if (!location) return ["loc", "", ""];
	return [
		"loc",
		location.file ?? "",
		location.line !== undefined ? String(location.line) : "",
	];
}

// ---------------------------------------------------------------------------
// computePatternFingerprint
// ---------------------------------------------------------------------------

/** The pattern-side inputs to a fingerprint. */
export interface PatternFingerprintInput {
	/** The detector id (DetectedPattern.id), e.g. "calcfields-in-loop". */
	patternId: string;
	/**
	 * Already-normalized location (via `normalizeSalientLocation`).
	 * OMIT for routine-anchored patterns (all 18 current detectors) — their
	 * identity is the routine, and it must survive line shifts. Only a future
	 * site-anchored detector passes a location, accepting that line drift then
	 * changes identity.
	 */
	salientLocation?: SalientLocation;
}

/**
 * Mint a `pattern:` fingerprint:
 * sha256(v1, "pattern", patternId, appId, routine identity, salient location),
 * hex-truncated to 16 chars.
 *
 * `appId` is normalized (dash-less lowercase) and hashed even when the
 * fallback identity carries it too — the spec formula includes it
 * unconditionally, and double inclusion is deterministic. Pass the SAME
 * method's declaring appId here and in the identity (use
 * `routineIdentityFromCorrelation` to build the identity).
 */
export function computePatternFingerprint(
	pattern: PatternFingerprintInput,
	identity: FingerprintRoutineIdentity,
	appId: string,
): FindingFingerprint {
	const tokens = [
		`v${FINGERPRINT_ALGO_VERSION}`,
		"pattern",
		pattern.patternId,
		normalizeAppGuid(appId),
		...identityTokens(identity),
		...locationTokens(pattern.salientLocation),
	];
	return {
		value: sha256Hex16(tokens),
		namespace: "pattern",
		algoVersion: FINGERPRINT_ALGO_VERSION,
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/lifecycle/fingerprint.test.ts`
Expected: PASS — 21 tests, 0 fail.

- [ ] **Step 5: Type-check and commit**

Run: `bunx tsc --noEmit` — expected: no output, exit 0.

```bash
git add src/lifecycle/fingerprint.ts test/lifecycle/fingerprint.test.ts
git commit -m "feat(lifecycle): pattern fingerprint hashing + canonical string form" -m "Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 3: alsem passthrough + telemetry fingerprint + namespace non-collision

**Files:**
- Modify: `src/lifecycle/fingerprint.ts` (append after `computePatternFingerprint`)
- Modify: `test/lifecycle/fingerprint.test.ts` (extend imports; append describe blocks)

**Interfaces:**
- Consumes (Tasks 1–2): `FindingFingerprint`, `FINGERPRINT_ALGO_VERSION`, `formatFingerprint`, `computePatternFingerprint`, internal `sha256Hex16`, plus `canonicalObjectType` / `normalizeTriggerName` / `normalizeAppGuid` from `src/semantic/identity.ts`.
- Produces:
  - `function wrapAlsemFingerprint(native: string): FindingFingerprint`
  - `interface TelemetryFingerprintInput { signalId: string; appId: string; objectType: string; objectNumber: number; routineName: string }`
  - `function computeTelemetryFingerprint(input: TelemetryFingerprintInput): FindingFingerprint`

- [ ] **Step 1: Write the failing test**

Extend the import block in `test/lifecycle/fingerprint.test.ts` to:

```typescript
import {
	FINGERPRINT_ALGO_VERSION,
	type FingerprintRoutineIdentity,
	computePatternFingerprint,
	computeTelemetryFingerprint,
	formatFingerprint,
	normalizeSalientLocation,
	wrapAlsemFingerprint,
} from "../../src/lifecycle/fingerprint.js";
```

Append at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// wrapAlsemFingerprint
// ---------------------------------------------------------------------------

describe("wrapAlsemFingerprint", () => {
	it("passes the native alsem fingerprint through verbatim (never re-hashed)", () => {
		const fp = wrapAlsemFingerprint("alsem-native-fp-xyz");
		expect(fp.value).toBe("alsem-native-fp-xyz");
	});

	it("stamps namespace 'alsem' and the current algo version", () => {
		const fp = wrapAlsemFingerprint("alsem-native-fp-xyz");
		expect(fp.namespace).toBe("alsem");
		expect(fp.algoVersion).toBe(FINGERPRINT_ALGO_VERSION);
	});

	it("string form prefixes the namespace exactly once", () => {
		const fp = wrapAlsemFingerprint("native:with:colons");
		expect(formatFingerprint(fp)).toBe("alsem:native:with:colons");
	});
});

// ---------------------------------------------------------------------------
// computeTelemetryFingerprint
// ---------------------------------------------------------------------------

describe("computeTelemetryFingerprint", () => {
	const INPUT = {
		signalId: "RT0018",
		appId: "437dbf0e-84ff-417a-965d-ed2bb9650972",
		objectType: "Codeunit",
		objectNumber: 50100,
		routineName: "ProcessRecords",
	};

	it("is deterministic and emits a 16-char lowercase hex value", () => {
		const a = computeTelemetryFingerprint(INPUT);
		const b = computeTelemetryFingerprint(INPUT);
		expect(a).toEqual(b);
		expect(a.value).toMatch(/^[0-9a-f]{16}$/);
	});

	it("stamps namespace 'telemetry' and the current algo version", () => {
		const fp = computeTelemetryFingerprint(INPUT);
		expect(fp.namespace).toBe("telemetry");
		expect(fp.algoVersion).toBe(FINGERPRINT_ALGO_VERSION);
	});

	it("different signalId on the same routine → different identity (RT0018 ≠ RT0005)", () => {
		const rt18 = computeTelemetryFingerprint(INPUT);
		const rt05 = computeTelemetryFingerprint({ ...INPUT, signalId: "RT0005" });
		expect(rt18.value).not.toBe(rt05.value);
	});

	it("normalizes like the pattern fallback key: casing, appId dashes, trigger prefix", () => {
		const canonical = computeTelemetryFingerprint(INPUT);
		const messy = computeTelemetryFingerprint({
			signalId: "RT0018",
			appId: "437DBF0E84FF417A965DED2BB9650972",
			objectType: "CodeUnit",
			objectNumber: 50100,
			routineName: "PROCESSRECORDS",
		});
		expect(messy.value).toBe(canonical.value);

		// Field-trigger names get the "<member> - " prefix stripped, like the join key.
		const bare = computeTelemetryFingerprint({
			...INPUT,
			routineName: "OnValidate",
		});
		const compound = computeTelemetryFingerprint({
			...INPUT,
			routineName: "Sell-to Customer No. - OnValidate",
		});
		expect(compound.value).toBe(bare.value);
	});
});

// ---------------------------------------------------------------------------
// Namespace non-collision
// ---------------------------------------------------------------------------

describe("namespace non-collision", () => {
	const FALLBACK: FingerprintRoutineIdentity = {
		kind: "fallback",
		appId: "437dbf0e84ff417a965ded2bb9650972",
		canonicalObjectType: "Codeunit",
		objectNumber: 50100,
		normalizedRoutineName: "processrecords",
	};

	it("pattern and telemetry over the same routine never share an identity", () => {
		const pattern = computePatternFingerprint(
			{ patternId: "high-hit-count" },
			FALLBACK,
			"437dbf0e-84ff-417a-965d-ed2bb9650972",
		);
		const telemetry = computeTelemetryFingerprint({
			signalId: "high-hit-count", // adversarial: same discriminator string
			appId: "437dbf0e-84ff-417a-965d-ed2bb9650972",
			objectType: "Codeunit",
			objectNumber: 50100,
			routineName: "ProcessRecords",
		});
		// The domain token makes even the raw hashes differ …
		expect(pattern.value).not.toBe(telemetry.value);
		// … and the namespace prefix guarantees distinct string forms regardless.
		expect(formatFingerprint(pattern)).not.toBe(formatFingerprint(telemetry));
	});

	it("an alsem native value equal to a pattern hash still cannot collide", () => {
		const pattern = computePatternFingerprint(
			{ patternId: "high-hit-count" },
			FALLBACK,
			"437dbf0e-84ff-417a-965d-ed2bb9650972",
		);
		const alsem = wrapAlsemFingerprint(pattern.value);
		expect(formatFingerprint(alsem)).not.toBe(formatFingerprint(pattern));
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/lifecycle/fingerprint.test.ts`
Expected: FAIL — `Export named 'wrapAlsemFingerprint' not found` (or equivalent). All 21 earlier tests still pass.

- [ ] **Step 3: Write the implementation**

Extend the identity import at the top of `src/lifecycle/fingerprint.ts` to:

```typescript
import {
	canonicalObjectType,
	normalizeAppGuid,
	normalizeTriggerName,
} from "../semantic/identity.js";
```

Append after `computePatternFingerprint`:

```typescript
// ---------------------------------------------------------------------------
// wrapAlsemFingerprint
// ---------------------------------------------------------------------------

/**
 * Wrap an alsem-native fingerprint (FindingSummary.fingerprint from
 * `src/semantic/contracts.ts`) under the `alsem:` namespace. PASSTHROUGH —
 * the native value is the identity; it is never re-hashed, so alsem's own
 * identity stability guarantees carry over unchanged.
 */
export function wrapAlsemFingerprint(native: string): FindingFingerprint {
	return {
		value: native,
		namespace: "alsem",
		algoVersion: FINGERPRINT_ALGO_VERSION,
	};
}

// ---------------------------------------------------------------------------
// computeTelemetryFingerprint
// ---------------------------------------------------------------------------

/**
 * The coarse routine-level key for telemetry findings (no call trees in
 * telemetry — object/method granularity is all there is).
 */
export interface TelemetryFingerprintInput {
	/** The signal discriminator, e.g. "RT0018" (long-running AL) or "RT0005" (long-running SQL). */
	signalId: string;
	appId: string;
	/** Any casing/spelling — canonicalized internally. */
	objectType: string;
	objectNumber: number;
	/** Raw routine name — trigger-normalized and lowercased internally. */
	routineName: string;
}

/**
 * Mint a `telemetry:` fingerprint over the coarse key
 * (signalId, appId, objectType, objectNumber, routineName), with the same
 * normalization as the pattern fallback key so a later deep-capture pattern
 * finding on the same routine correlates cleanly at the routine level.
 */
export function computeTelemetryFingerprint(
	input: TelemetryFingerprintInput,
): FindingFingerprint {
	const tokens = [
		`v${FINGERPRINT_ALGO_VERSION}`,
		"telemetry",
		input.signalId,
		normalizeAppGuid(input.appId),
		canonicalObjectType(input.objectType),
		String(input.objectNumber),
		normalizeTriggerName(input.routineName).toLowerCase(),
	];
	return {
		value: sha256Hex16(tokens),
		namespace: "telemetry",
		algoVersion: FINGERPRINT_ALGO_VERSION,
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/lifecycle/fingerprint.test.ts`
Expected: PASS — 30 tests, 0 fail.

- [ ] **Step 5: Type-check and commit**

Run: `bunx tsc --noEmit` — expected: no output, exit 0.

```bash
git add src/lifecycle/fingerprint.ts test/lifecycle/fingerprint.test.ts
git commit -m "feat(lifecycle): alsem passthrough + telemetry fingerprints" -m "Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 4: Routine identity from correlation buckets

**Files:**
- Modify: `src/lifecycle/fingerprint.ts` (append after `computeTelemetryFingerprint`)
- Modify: `test/lifecycle/fingerprint.test.ts` (extend imports; append describe block)

**Interfaces:**
- Consumes (Task 1): `FingerprintRoutineIdentity`. Consumes (existing code): `SemanticAttribution` from `src/types/fused.ts` (`status`, `stableRoutineId?: string | string[]`, `findings`, `attributionConfidence` — the last two only to construct valid test values); `canonicalObjectType` / `normalizeTriggerName` / `normalizeAppGuid` from `src/semantic/identity.ts`.
- Produces:
  - `function routineIdentityFromCorrelation(attribution: SemanticAttribution | undefined, method: { appId?: string; objectType: string; objectId: number; functionName: string }): FingerprintRoutineIdentity`

- [ ] **Step 1: Write the failing test**

Extend the import block in `test/lifecycle/fingerprint.test.ts` to:

```typescript
import {
	FINGERPRINT_ALGO_VERSION,
	type FingerprintRoutineIdentity,
	computePatternFingerprint,
	computeTelemetryFingerprint,
	formatFingerprint,
	normalizeSalientLocation,
	routineIdentityFromCorrelation,
	wrapAlsemFingerprint,
} from "../../src/lifecycle/fingerprint.js";
import type { SemanticAttribution } from "../../src/types/fused.js";
```

Append at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// routineIdentityFromCorrelation
// ---------------------------------------------------------------------------

describe("routineIdentityFromCorrelation", () => {
	const METHOD = {
		appId: "437DBF0E-84FF-417A-965D-ED2BB9650972",
		objectType: "CodeUnit",
		objectId: 50100,
		functionName: "ProcessRecords",
	};

	const SID = "437dbf0e-84ff-417a-965d-ed2bb9650972:Codeunit:50100#a1b2c3d4";

	it("matched with a single stableRoutineId → stable identity", () => {
		const attr: SemanticAttribution = {
			status: "matched",
			findings: [],
			attributionConfidence: "exact",
			stableRoutineId: SID,
		};
		expect(routineIdentityFromCorrelation(attr, METHOD)).toEqual({
			kind: "stable",
			stableRoutineId: SID,
		});
	});

	it("ambiguous NEVER mints a stable identity, even though candidate ids are present", () => {
		const attr: SemanticAttribution = {
			status: "ambiguous",
			findings: [],
			attributionConfidence: "ambiguous",
			stableRoutineId: [SID, `${SID}ff`],
		};
		const id = routineIdentityFromCorrelation(attr, METHOD);
		expect(id.kind).toBe("fallback");
	});

	it("blind-spot → fallback identity", () => {
		const attr: SemanticAttribution = {
			status: "blind-spot",
			findings: [],
			attributionConfidence: "exact",
			reason: "object Codeunit 50100 was not analyzed",
		};
		expect(routineIdentityFromCorrelation(attr, METHOD).kind).toBe("fallback");
	});

	it("no attribution at all (profile-only, no fusion) → fallback identity", () => {
		expect(routineIdentityFromCorrelation(undefined, METHOD).kind).toBe(
			"fallback",
		);
	});

	it("matched but stableRoutineId is an array → fallback (defensive)", () => {
		const attr: SemanticAttribution = {
			status: "matched",
			findings: [],
			attributionConfidence: "exact",
			stableRoutineId: [SID],
		};
		expect(routineIdentityFromCorrelation(attr, METHOD).kind).toBe("fallback");
	});

	it("fallback fields are fully normalized", () => {
		const id = routineIdentityFromCorrelation(undefined, {
			appId: "437DBF0E-84FF-417A-965D-ED2BB9650972",
			objectType: "CodeUnit",
			objectId: 50100,
			functionName: "Sell-to Customer No. - OnValidate",
		});
		expect(id).toEqual({
			kind: "fallback",
			appId: "437dbf0e84ff417a965ded2bb9650972",
			canonicalObjectType: "Codeunit",
			objectNumber: 50100,
			normalizedRoutineName: "onvalidate",
		});
	});

	it("absent appId → fallback with empty appId (profile-only findings stay fingerprintable)", () => {
		const id = routineIdentityFromCorrelation(undefined, {
			objectType: "Codeunit",
			objectId: 50100,
			functionName: "ProcessRecords",
		});
		expect(id).toEqual({
			kind: "fallback",
			appId: "",
			canonicalObjectType: "Codeunit",
			objectNumber: 50100,
			normalizedRoutineName: "processrecords",
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/lifecycle/fingerprint.test.ts`
Expected: FAIL — `Export named 'routineIdentityFromCorrelation' not found`. All 30 earlier tests still pass.

- [ ] **Step 3: Write the implementation**

Add this import at the top of `src/lifecycle/fingerprint.ts` (after the identity import):

```typescript
import type { SemanticAttribution } from "../types/fused.js";
```

Append after `computeTelemetryFingerprint`:

```typescript
// ---------------------------------------------------------------------------
// routineIdentityFromCorrelation
// ---------------------------------------------------------------------------

/**
 * Derive the fingerprint routine identity from a correlation outcome.
 *
 * ONLY a confident match mints a stable identity:
 * `status === "matched"` with a SINGLE (string) stableRoutineId.
 * Everything else — `ambiguous` (never trust a union), `blind-spot`,
 * no attribution at all (profile-only / cold / unkeyable have no per-method
 * attribution), or a defensive array-typed id on `matched` — falls back to
 * the normalized key (appId, canonicalObjectType, objectNumber,
 * normalizedRoutineName), so profile-only findings are ALWAYS
 * fingerprintable.
 *
 * When a source registers later and the same routine gains a confident
 * match, the fallback-key finding is linked to its stable identity via
 * `linkFingerprints(old, new, "identity-upgrade")` — this function never
 * guesses ahead of that migration.
 *
 * @param attribution The method's `SemanticAttribution` from the FusedModel
 *                    side-map, or `undefined` when fusion is off/absent.
 * @param method      The method identity fields from `MethodBreakdown`
 *                    (appId is optional there — absent for System frames).
 */
export function routineIdentityFromCorrelation(
	attribution: SemanticAttribution | undefined,
	method: {
		appId?: string;
		objectType: string;
		objectId: number;
		functionName: string;
	},
): FingerprintRoutineIdentity {
	if (
		attribution?.status === "matched" &&
		typeof attribution.stableRoutineId === "string"
	) {
		return { kind: "stable", stableRoutineId: attribution.stableRoutineId };
	}
	return {
		kind: "fallback",
		appId: normalizeAppGuid(method.appId),
		canonicalObjectType: canonicalObjectType(method.objectType),
		objectNumber: method.objectId,
		normalizedRoutineName: normalizeTriggerName(
			method.functionName,
		).toLowerCase(),
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/lifecycle/fingerprint.test.ts`
Expected: PASS — 37 tests, 0 fail.

- [ ] **Step 5: Type-check and commit**

Run: `bunx tsc --noEmit` — expected: no output, exit 0.

```bash
git add src/lifecycle/fingerprint.ts test/lifecycle/fingerprint.test.ts
git commit -m "feat(lifecycle): routine identity from correlation buckets" -m "Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

### Task 5: Fingerprint migration links + final verification

**Files:**
- Modify: `src/lifecycle/fingerprint.ts` (append at end)
- Modify: `test/lifecycle/fingerprint.test.ts` (extend imports; append describe block)

**Interfaces:**
- Consumes (Tasks 1–3): `FindingFingerprint`, `formatFingerprint`, `computePatternFingerprint`, `wrapAlsemFingerprint`, `FingerprintRoutineIdentity`.
- Produces:
  - `type FingerprintMigrationReason = "algo-upgrade" | "identity-upgrade" | "manual-merge"`
  - `interface FingerprintMigration { from: FindingFingerprint; to: FindingFingerprint; reason: FingerprintMigrationReason }`
  - `function linkFingerprints(oldFp: FindingFingerprint, newFp: FindingFingerprint, reason?: FingerprintMigrationReason): FingerprintMigration`

- [ ] **Step 1: Write the failing test**

Extend the import block in `test/lifecycle/fingerprint.test.ts` to:

```typescript
import {
	FINGERPRINT_ALGO_VERSION,
	type FindingFingerprint,
	type FingerprintRoutineIdentity,
	computePatternFingerprint,
	computeTelemetryFingerprint,
	formatFingerprint,
	linkFingerprints,
	normalizeSalientLocation,
	routineIdentityFromCorrelation,
	wrapAlsemFingerprint,
} from "../../src/lifecycle/fingerprint.js";
import type { SemanticAttribution } from "../../src/types/fused.js";
```

Append at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// linkFingerprints
// ---------------------------------------------------------------------------

describe("linkFingerprints", () => {
	const FALLBACK: FingerprintRoutineIdentity = {
		kind: "fallback",
		appId: "437dbf0e84ff417a965ded2bb9650972",
		canonicalObjectType: "Codeunit",
		objectNumber: 50100,
		normalizedRoutineName: "processrecords",
	};
	const STABLE: FingerprintRoutineIdentity = {
		kind: "stable",
		stableRoutineId:
			"437dbf0e-84ff-417a-965d-ed2bb9650972:Codeunit:50100#a1b2c3d4",
	};
	const APP = "437dbf0e-84ff-417a-965d-ed2bb9650972";

	const v1Fp = computePatternFingerprint(
		{ patternId: "calcfields-in-loop" },
		FALLBACK,
		APP,
	);
	// A future-algo fingerprint, constructed literally (FindingFingerprint is
	// a plain data type; only THIS module can mint v-current hashes).
	const v2Fp: FindingFingerprint = {
		value: "0123456789abcdef",
		namespace: "pattern",
		algoVersion: 2,
	};

	it("produces a migration record with default reason 'algo-upgrade'", () => {
		const migration = linkFingerprints(v1Fp, v2Fp);
		expect(migration).toEqual({ from: v1Fp, to: v2Fp, reason: "algo-upgrade" });
	});

	it("algo-upgrade requires a strictly increasing algoVersion", () => {
		expect(() => linkFingerprints(v2Fp, v1Fp, "algo-upgrade")).toThrow();
		const sameVersion: FindingFingerprint = {
			...v1Fp,
			value: "fedcba9876543210",
		};
		expect(() => linkFingerprints(v1Fp, sameVersion, "algo-upgrade")).toThrow();
	});

	it("algo-upgrade requires the same namespace", () => {
		const telemetryV2: FindingFingerprint = {
			value: "0123456789abcdef",
			namespace: "telemetry",
			algoVersion: 2,
		};
		expect(() => linkFingerprints(v1Fp, telemetryV2, "algo-upgrade")).toThrow();
	});

	it("identity-upgrade links a fallback-key finding to its stable identity at the same version", () => {
		const stableFp = computePatternFingerprint(
			{ patternId: "calcfields-in-loop" },
			STABLE,
			APP,
		);
		const migration = linkFingerprints(v1Fp, stableFp, "identity-upgrade");
		expect(migration.reason).toBe("identity-upgrade");
		expect(migration.from).toEqual(v1Fp);
		expect(migration.to).toEqual(stableFp);
	});

	it("identity-upgrade requires the same namespace", () => {
		const alsemFp = wrapAlsemFingerprint("native-x");
		expect(() => linkFingerprints(v1Fp, alsemFp, "identity-upgrade")).toThrow();
	});

	it("manual-merge allows cross-namespace links (rename mitigation)", () => {
		const alsemFp = wrapAlsemFingerprint("native-x");
		const migration = linkFingerprints(v1Fp, alsemFp, "manual-merge");
		expect(migration.reason).toBe("manual-merge");
	});

	it("refuses to link an identity to itself", () => {
		expect(() => linkFingerprints(v1Fp, { ...v1Fp })).toThrow();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/lifecycle/fingerprint.test.ts`
Expected: FAIL — `Export named 'linkFingerprints' not found`. All 37 earlier tests still pass.

- [ ] **Step 3: Write the implementation**

Append at the end of `src/lifecycle/fingerprint.ts`:

```typescript
// ---------------------------------------------------------------------------
// Fingerprint migration (algo upgrades, identity upgrades, manual merges)
// ---------------------------------------------------------------------------

/**
 * Why two fingerprints are the same finding:
 *  - "algo-upgrade"     — FINGERPRINT_ALGO_VERSION bumped; the re-fingerprint
 *                         migration links every old identity to its
 *                         recomputed successor.
 *  - "identity-upgrade" — a source registered later and the routine gained a
 *                         confident alsem match; the fallback-key identity is
 *                         linked to the stableRoutineId identity.
 *  - "manual-merge"     — human-confirmed merge (e.g. after a rename severed
 *                         stableRoutineId); the only reason permitted to
 *                         cross namespaces.
 */
export type FingerprintMigrationReason =
	| "algo-upgrade"
	| "identity-upgrade"
	| "manual-merge";

/**
 * A migration record linking an old identity to its successor. This module
 * only DEFINES the record — executing migrations (rewriting store rows,
 * guarding sinks against mass state transitions) is the phase-3 lifecycle
 * store's job.
 */
export interface FingerprintMigration {
	from: FindingFingerprint;
	to: FindingFingerprint;
	reason: FingerprintMigrationReason;
}

/**
 * Build a migration record linking `oldFp` → `newFp`.
 *
 * Guards (throws TypeError on violation):
 *  - from and to must not be the same identity (same string form AND version).
 *  - "algo-upgrade": same namespace, and to.algoVersion > from.algoVersion.
 *  - "identity-upgrade": same namespace (fallback→stable is within `pattern:`).
 *  - "manual-merge": no structural guard (human judgement is the guard).
 */
export function linkFingerprints(
	oldFp: FindingFingerprint,
	newFp: FindingFingerprint,
	reason: FingerprintMigrationReason = "algo-upgrade",
): FingerprintMigration {
	if (
		formatFingerprint(oldFp) === formatFingerprint(newFp) &&
		oldFp.algoVersion === newFp.algoVersion
	) {
		throw new TypeError(
			"linkFingerprints: from and to are the same identity — nothing to link",
		);
	}
	if (reason === "algo-upgrade") {
		if (oldFp.namespace !== newFp.namespace) {
			throw new TypeError(
				`linkFingerprints: algo-upgrade cannot change namespace (${oldFp.namespace} → ${newFp.namespace})`,
			);
		}
		if (newFp.algoVersion <= oldFp.algoVersion) {
			throw new TypeError(
				`linkFingerprints: algo-upgrade requires a version increase (${oldFp.algoVersion} → ${newFp.algoVersion})`,
			);
		}
	}
	if (reason === "identity-upgrade" && oldFp.namespace !== newFp.namespace) {
		throw new TypeError(
			`linkFingerprints: identity-upgrade cannot change namespace (${oldFp.namespace} → ${newFp.namespace})`,
		);
	}
	return { from: oldFp, to: newFp, reason };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/lifecycle/fingerprint.test.ts`
Expected: PASS — 44 tests, 0 fail.

- [ ] **Step 5: Full verification**

Run each and confirm:

1. `bun test test/lifecycle/fingerprint.test.ts` — expected: 44 pass, 0 fail.
2. `bun test` — expected: full suite passes (this module touches no existing files, so any failure here is pre-existing; verify by checking the failing file is not `test/lifecycle/fingerprint.test.ts` and report it rather than "fixing" unrelated code).
3. `bunx tsc --noEmit` — expected: no output, exit 0.
4. `bunx biome check src/lifecycle/fingerprint.ts test/lifecycle/fingerprint.test.ts` — expected: no diagnostics. If formatting diagnostics appear, run `bunx biome check --write src/lifecycle/fingerprint.ts test/lifecycle/fingerprint.test.ts` and re-run the tests.

- [ ] **Step 6: Commit**

```bash
git add src/lifecycle/fingerprint.ts test/lifecycle/fingerprint.test.ts
git commit -m "feat(lifecycle): fingerprint migration links (algo/identity/manual)" -m "Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp"
```

---

## Spec Coverage Checklist (self-review record)

| Spec requirement (umbrella §4 / task scope) | Where |
|---|---|
| Namespaces `alsem:` / `pattern:` / `telemetry:`, never collide | Task 1 types; Task 3 non-collision tests |
| Pattern fingerprint = hash(patternId + routine identity + appId + salient location) | Task 2 `computePatternFingerprint` |
| Routine identity = stableRoutineId on confident match, else fallback key | Task 4 `routineIdentityFromCorrelation` |
| Profile-only findings ALWAYS fingerprintable (absent appId tolerated) | Task 4 tests (no attribution, absent appId) |
| Ambiguous never mints stableRoutineId fingerprints | Task 4 test + Design Decision 9 |
| Salient location normalized, capture-kind-independent (ir-json 0-based → +1) | Task 1 `normalizeSalientLocation` + tests; Task 2 hash-level equivalence test |
| Line-shift stability decision for loop-type patterns | Design Decision 3; Task 2 tests |
| `fingerprintAlgoVersion` stored with every finding | `algoVersion` field, stamped by all three constructors; tests in Tasks 2–3 |
| Migration helper links old→new on algorithm upgrade | Task 5 `linkFingerprints` / `FingerprintMigration` |
| Known rename limitation documented in code | Task 1 module doc comment (KNOWN LIMITATION block) |
| Pure, node:crypto sha256, hex-truncated 16, deterministic ordering | Global Constraints; Task 2 token contract |
| SQLite storage / lifecycle states / sink mapping / migration execution | OUT of scope (phase 3) — noted in `FingerprintMigration` doc |
