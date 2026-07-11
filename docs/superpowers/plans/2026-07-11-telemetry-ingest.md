# Telemetry Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest App Insights BC telemetry signals (RT0018 long-running AL, RT0005 long-running SQL) as coarse-grained lifecycle findings — the SaaS-production trigger layer from the umbrella spec (§ Telemetry track).

**Architecture:** A normalized `telemetry-batch` JSON contract (schema v1) is the seam: adapters (CLI puller, future exporters) normalize App Insights rows into it; the server and CLI stay KQL-ignorant. Batches flow through the EXISTING lifecycle engine — the parser mints `telemetry:` fingerprints (already implemented in `src/lifecycle/fingerprint.ts`) and synthesizes a minimal `AnalysisResult` so `evaluateRun` handles state transitions, absence, and events unchanged. Telemetry runs get `captureKind: "telemetry"` (schema v3), which the existing capture-kind keying already isolates from profile baselines.

**Tech Stack:** Bun, TypeScript, bun:sqlite, plain fetch (App Insights REST API v1), bun:test.

## Global Constraints

- Tabs for indentation; biome clean; `bunx tsc --noEmit` clean.
- TDD: failing test first for every behavior change. Test runs: `AI_DISABLED=1 bun test <file>`; full suite once before each task's final commit.
- Every commit message ends with the trailer:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- Zero new dependencies. App Insights puller uses plain fetch with injectable `fetchImpl`.
- **Credential discipline** (matches the GitHub sink): the App Insights API key is read ONLY from `process.env[apiKeyEnv]` at call time, never logged, never echoed in errors, never stored in config files. Missing env var = clear operator error naming the env var NAME, nonzero exit.
- **Fingerprint stability**: telemetry fingerprints come ONLY from `computeTelemetryFingerprint` (`src/lifecycle/fingerprint.ts:311`) — never a second minting path. The coarse key is (signalId, appId, objectType, objectNumber, routineName).
- **Baseline isolation**: `telemetry` capture-kind runs must NEVER contribute to or read `sampling`/`instrumentation` baselines. The existing capture-kind keying provides this — tests must prove it, not assume it.
- Ingest hardening bar matches ir-json: gzip magic-byte detection, bounded decompression (`gunzipBounded`), size budget `AL_PERF_MAX_PROFILE_BYTES`, signal-count budget, unknown-key tolerance (additive evolution without version bump).
- All attacker-influenceable strings (object names, method names, app names from telemetry) flow into finding titles → they already pass through the sink's escaping at the last hop. Do NOT add escaping at ingest (single-escape discipline, matches profile path).

## Design Decisions (locked)

- **D1 — Normalized batch, not raw KQL.** The server accepts only the normalized `telemetry-batch` v1 shape. KQL knowledge lives in the puller adapter alone (umbrella spec: "Adding a source is an adapter, not a redesign").
- **D2 — Reuse `evaluateRun`, don't fork it.** The parser synthesizes a stub `AnalysisResult` whose `patterns[]` carry pre-minted `telemetry:` fingerprints. State machine, absence counting, event logging, digest, and sink triggers all work unchanged. No `evaluateTelemetryBatch` state-machine clone.
- **D3 — Absence gating via exercised apps.** A telemetry finding only accrues absence when its app appears in a later batch without the finding. The stub result must therefore surface the batch's apps as "exercised" the same way profile hotspots do.
- **D4 — Severity from config thresholds** on `maxDurationMs` per signal: default RT0018 warning ≥ 10 000 ms / critical ≥ 30 000 ms; RT0005 warning ≥ 10 000 ms / critical ≥ 60 000 ms; unknown signalIds default warning (never dropped — forward-compatible with job-queue signals).
- **D5 — Runs stream defaults to `"telemetry"`** (overridable). Absence/resolve semantics stay coherent because runs are stream-scoped.
- **D6 — Puller is pull-and-print or pull-and-evaluate.** `--out` writes the batch JSON (for scheduled export → later ship), no `--out` evaluates directly into the local lifecycle DB. Shipping a batch to `/api/ingest` reuses the existing multipart contract (the batch IS the profile part).

---

### Task 1: Schema v3 — `telemetry` capture kind

**Files:**
- Modify: `src/lifecycle/store.ts` (LIFECYCLE_SCHEMA_VERSION 2→3, new migration, type widening)
- Modify: `src/lifecycle/fingerprint.ts` (CaptureKind union — line 89)
- Modify: `src/lifecycle/evaluate.ts` (RunMetadata.captureKind — line 67)
- Test: `test/lifecycle/migrations.test.ts`, `test/lifecycle/store.test.ts`

**Interfaces:**
- Produces: `captureKind: "sampling" | "instrumentation" | "telemetry"` accepted by `recordRun` and persisted; `CaptureKind = "alcpuprofile" | "ir-json" | "telemetry-batch"` (wire-format union in fingerprint.ts stays wire-named).

SQLite cannot ALTER a CHECK constraint — the migration rebuilds the `runs` table (12-step alter: create `runs_new` with the widened CHECK, copy, drop, rename, recreate indexes). Follow the exact pattern of `LIFECYCLE_MIGRATIONS[1]` (schema v2) for transaction discipline.

- [ ] **Step 1: Failing migration test** — open a v2 DB (reuse the genuine-v2 fixture builder from the schema-v2 tests), migrate, then `recordRun` with `captureKind: "telemetry"`:

```typescript
test("v3 accepts telemetry capture kind; v2 data survives rebuild", () => {
	const store = openV2FixtureWithOneRun(); // helper exists in migrations.test.ts
	const rec = store.recordRun({
		tenant: "t",
		stream: "telemetry",
		profileId: "batch-1",
		captureKind: "telemetry",
		captureTime: "2026-07-11T00:00:00.000Z",
		versionStamp: null,
		incomplete: false,
		exercisedApps: [],
	});
	expect(rec.duplicate).toBe(false);
	// pre-migration run row survived the table rebuild byte-for-byte
	expect(store.getRunByProfileId("t", "existing-profile")).toBeTruthy();
});
```

- [ ] **Step 2: Run — expect FAIL** (`CHECK constraint failed`).
- [ ] **Step 3: Implement** — bump `LIFECYCLE_SCHEMA_VERSION` to 3; append `LIFECYCLE_MIGRATIONS[2]` doing the runs-table rebuild with `CHECK (capture_kind IN ('sampling','instrumentation','telemetry'))`; widen the TS union in `recordRun`'s arg type, the row mapper (store.ts:525), `RunMetadata` (evaluate.ts:67), and add `"telemetry-batch"` to `CaptureKind` (fingerprint.ts:89).
- [ ] **Step 4: Run migration + store + full lifecycle test files — PASS.**
- [ ] **Step 5: Commit** — `feat(lifecycle): schema v3 — telemetry capture kind`

### Task 2: `telemetry-batch` contract + parser

**Files:**
- Create: `src/types/telemetry.ts`
- Create: `src/core/telemetry-parser.ts`
- Modify: `src/lifecycle/config.ts` (threshold defaults)
- Test: `test/core/telemetry-contract.test.ts`, `test/core/telemetry-parser.test.ts`

**Interfaces:**
- Produces: `TELEMETRY_BATCH_SCHEMA_VERSION = 1`; `isTelemetryBatchDocument(text: string): boolean` (cheap sniff, mirrors `isIrJsonDocument`); `parseTelemetryBatch(json: unknown, config: LifecycleConfig): ParsedTelemetryBatch`.

```typescript
// src/types/telemetry.ts
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
```

Parser responsibilities (each is a test case):
1. Validate shape fail-closed: `schemaVersion !== 1` → throw naming the version; missing/NaN required fields → throw naming the field and index; unknown top-level/extra signal keys → IGNORED (additive evolution).
2. Signal-count budget: > `config.telemetry.maxSignalsPerBatch` (default 10 000) → throw.
3. Mint fingerprint per signal via `computeTelemetryFingerprint({ signalId, appId, objectType, objectNumber: objectId, routineName: methodName })`.
4. Severity via config thresholds on `maxDurationMs` (D4). Config shape added to `DEFAULT_LIFECYCLE_CONFIG`:

```typescript
telemetry: {
	maxSignalsPerBatch: 10_000,
	severity: {
		RT0018: { warningMs: 10_000, criticalMs: 30_000 },
		RT0005: { warningMs: 10_000, criticalMs: 60_000 },
		default: { warningMs: 10_000, criticalMs: 60_000 },
	},
},
```

5. Synthesize the stub `AnalysisResult` (D2/D3). Patterns carry the minted fingerprint via `formatFingerprint`; the hotspot per app makes the app "exercised" for absence gating:

```typescript
export interface ParsedTelemetryBatch {
	result: AnalysisResult; // stub: patterns[] + minimal hotspots + meta
	windowEnd: string; // canonical captureTime for RunMetadata
	signalCount: number;
}
```

Stub construction rules (exact):
- `patterns[i]`: `id: "telemetry-" + signalId.toLowerCase()`, severity from thresholds, `title: \`${signalId}: ${methodName} (${objectType} ${objectId}) slow — max ${maxDurationMs}ms × ${count}\``, `involvedMethods: [\`${methodName} (${objectType} ${objectId})\`]`, `impact: maxDurationMs * 1000` (µs, consistent with profile impact units), `evidence: \`${count} occurrence(s) in window ${windowStart}..${windowEnd}, max ${maxDurationMs}ms, avg ${avgDurationMs ?? "n/a"}ms\``, `fingerprint: formatFingerprint(computeTelemetryFingerprint(...))`.
- One `hotspots[]` entry per DISTINCT appName in the batch (functionName `"<telemetry>"`, appName set, zero times) — this is what `exercisedAppsOf` consumes. Verify against `buildMethodIndex`/`exercisedAppsOf` in evaluate.ts while implementing; if exercised-apps derivation reads a different field, adapt the stub, and the Task 3 absence tests are the proof either way.
- `meta`: `captureKind: undefined` is NOT allowed — but profile-only meta fields don't apply; set `profileType: "instrumentation"` placeholder values ONLY where the type demands them, `sourceFormat` left absent, `analyzedAt` = now. The stub never reaches formatters; it exists solely for `evaluateRun`.

- [ ] **Step 1: Contract test** (mirrors `test/core/irjson-contract.test.ts`): version pin, unknown-key tolerance, fail-closed on missing fields.
- [ ] **Step 2–4: TDD the parser** per the six responsibilities above (each numbered responsibility gets at least one failing test first).
- [ ] **Step 5: Fingerprint stability test** — same signal in two batches mints the identical fingerprint string; differing only in casing/trigger-prefix of methodName still collides (normalization proof via `normalizeTriggerName`).
- [ ] **Step 6: Commit** — `feat(telemetry): telemetry-batch v1 contract and parser`

### Task 3: Lifecycle wiring — `evaluateTelemetryBatch`

**Files:**
- Create: `src/lifecycle/telemetry.ts` (thin wrapper, ~40 lines)
- Test: `test/lifecycle/telemetry-evaluate.test.ts`

**Interfaces:**
- Consumes: `parseTelemetryBatch` (Task 2), `evaluateRun` (existing).
- Produces: `evaluateTelemetryBatch(store, batchJson: unknown, run: Omit<RunMetadata, "captureKind" | "captureTime">, configPatch?): EvaluationOutcome` — fills `captureKind: "telemetry"` and `captureTime: parsed.windowEnd`, delegates to `evaluateRun(store, parsed.result, fullRun, configPatch)`.

Behavior tests (each failing-first):
- [ ] **First batch**: RT0018 signal → finding created, state `new`, `source` column is `telemetry` (namespace derived), fingerprint `telemetry:<16hex>`.
- [ ] **Recurrence**: second batch (later windowEnd, same signal) → state `open`, occurrence count 2.
- [ ] **Absence gating (D3)**: third batch contains the same APP (another signal from it) but not the finding → absenceCount increments. Batch WITHOUT that app at all → absenceCount unchanged.
- [ ] **Resolve**: `resolveAfter` consecutive absences (app exercised each time) → `resolved`.
- [ ] **Baseline isolation**: after telemetry batches, `sampling`-kind baseline queries return nothing telemetry-tainted — assert `routine_metrics` has NO rows with `capture_kind = 'telemetry'` (the stub has no timed hotspots) AND a subsequent profile evaluateRun's baseline lookups are unaffected (metricClass `no-baseline` for a fresh profile finding, not polluted).
- [ ] **Duplicate batch** (same profileId): `skipped: "duplicate-run"`.
- [ ] **Sink flow-through**: with the github sink enabled + autoFile on + hysteresis 2, two batches → `processEventsForSinks` enqueues a create-issue row for the telemetry finding (proves the trigger layer reaches the sink unchanged; reuse the Task-5-style test harness from `test/lifecycle/sinks/triggers.test.ts`).
- [ ] **Commit** — `feat(lifecycle): evaluate telemetry batches through the finding lifecycle`

### Task 4: Web ingest seam

**Files:**
- Modify: `web/handlers/ingest.ts` (payload discriminator)
- Test: `test/web/ingest-telemetry.test.ts` (mirror `test/web/ingest-irjson.test.ts` harness)

**Interfaces:**
- Consumes: `isTelemetryBatchDocument`, `evaluateTelemetryBatch`.
- Produces: `/api/ingest` accepts a gzipped-or-plain `telemetry-batch` JSON as the `profile` part with manifest `captureKind: "telemetry"`.

Discriminator placement: after gunzip/budget (existing code), where ir-json sniffing already happens — `isTelemetryBatchDocument` checks `"payloadType":"telemetry-batch"` cheaply before full parse. On telemetry: SKIP profile analysis entirely (no `analyzeProfile`, no flamegraph, no stored `AnalysisResult` beyond the batch itself), store the raw batch + manifest in the activity dir (same encrypted-bundle path as profiles), and when `AL_PERF_LIFECYCLE=1` call `evaluateTelemetryBatch` with tenant = authenticated tenant, stream = manifest.scheduleId ?? "telemetry", profileId = activityId.

- [ ] **Step 1: Failing test** — POST a gzipped telemetry batch with valid tenant token → 200 `{ status: "stored" }`; with `AL_PERF_LIFECYCLE=1` the lifecycle DB contains the finding; idempotent re-POST → `duplicate`.
- [ ] **Step 2: Failing test (hardening)** — oversized batch (signal count over budget) → 4xx naming the budget; malformed batch (`schemaVersion: 2`) → 400 with the parser's message; auth still enforced (401 without token).
- [ ] **Step 3: Implement discriminator + wiring.**
- [ ] **Step 4: Run web test files + full suite — PASS.**
- [ ] **Step 5: Commit** — `feat(web): ingest telemetry batches through the capture-source adapter seam`

### Task 5: CLI — local evaluate + App Insights puller

**Files:**
- Create: `src/lifecycle/appinsights.ts` (puller core: KQL constants, REST call, row→batch normalization; injectable fetchImpl)
- Modify: `src/cli/commands/lifecycle.ts` (two subcommands)
- Test: `test/lifecycle/appinsights.test.ts`, extend `test/lifecycle/cli.test.ts`

**Interfaces:**
- Produces:
  - `lifecycle telemetry <batch.json> [--tenant --stream -f json]` — evaluate a local batch file into the lifecycle DB (uses `evaluateTelemetryBatch`).
  - `lifecycle pull-telemetry --app-id <guid> [--api-key-env APPINSIGHTS_API_KEY] [--since <ISO|4h>] [--signals RT0018,RT0005] [--out batch.json] [--tenant --stream -f json]` — query App Insights REST API v1, normalize to a batch, then `--out` writes JSON (no evaluation) or no `--out` evaluates locally.
  - `pullTelemetry(opts, fetchImpl?): Promise<TelemetryBatchDocument>` exported for tests.

App Insights REST contract (pin in mocked tests):
- `GET https://api.applicationinsights.io/v1/apps/{appId}/query?query=<urlencoded KQL>` with header `x-api-key: <key>`.
- Response: `{ tables: [{ name: "PrimaryTable", columns: [{name,type}...], rows: [[...]] }] }`.

KQL constants (one per signal, `{since}` substituted from `--since`, aggregation server-side so the batch arrives pre-aggregated):

```
traces
| where timestamp > datetime({since})
| where customDimensions.eventId == "RT0018"
| extend appId = tostring(customDimensions.extensionId),
         appName = tostring(customDimensions.extensionName),
         objectType = tostring(customDimensions.alObjectType),
         objectId = toint(customDimensions.alObjectId),
         objectName = tostring(customDimensions.alObjectName),
         methodName = tostring(customDimensions.alMethod),
         ms = todouble(customDimensions.executionTimeInMs)
| summarize count = count(), maxDurationMs = max(ms), avgDurationMs = avg(ms)
    by appId, appName, objectType, objectId, objectName, methodName
```

(RT0005 analogous with `eventId == "RT0005"`; `methodName` falls back to `tostring(customDimensions.alStackTrace)` first line when `alMethod` is empty — normalize in TS, not KQL.) NOTE for the implementer: BC emits `executionTime` as a timespan string on some event versions and `executionTimeInMs` as a number on others — the normalizer must accept both (`parseTimespanMs("00:00:12.345") → 12345`), covered by a unit test with both row shapes.

Behavior tests (mocked fetch):
- [ ] Request pinning: URL path contains the app id, query is url-encoded, `x-api-key` header present, key value never appears in any thrown error or console output (decoy-secret pattern from sync-cli tests).
- [ ] Missing env var: error names `APPINSIGHTS_API_KEY` (or the `--api-key-env` override), exit 1, zero fetch calls.
- [ ] Row normalization: a two-table/one-table response with both `executionTimeInMs` and timespan variants → correct `TelemetrySignal[]`; batch validates against Task 2's parser (round-trip test: pull → parse → fingerprints minted).
- [ ] HTTP 401/404 → clear permanent error; 429/5xx → error naming retryability (the puller does NOT retry in v1 — it's cron-driven; document that).
- [ ] `--out` writes the batch and does NOT touch the DB; no `--out` evaluates (findings appear).
- [ ] **Commit** — `feat(cli): lifecycle telemetry evaluate and App Insights puller`

### Task 6: Digest visibility + operator docs

**Files:**
- Modify: `src/lifecycle/digest.ts` (ONLY if the signal tag needs surfacing — see step 1)
- Create: `docs/telemetry-recipe.md`
- Modify: `CLAUDE.md` (one-line lifecycle section addition)
- Test: extend `test/lifecycle/digest.test.ts`

- [ ] **Step 1: Digest test first** — a telemetry finding appears in the digest with its `telemetry:` fingerprint and RT-prefixed title (the title already carries the signal id from Task 2's format). If the existing digest renders it correctly with zero changes, the test IS the deliverable — do not add a telemetry section nobody asked for (YAGNI). Assert the JSON digest contract's 11 locked fields are untouched.
- [ ] **Step 2: `docs/telemetry-recipe.md`** — operator recipe mirroring `docs/lifecycle-gh-recipe.md` structure: ISV setup (`applicationInsightsConnectionString` in app.json ships fleet-wide telemetry), where to find the App Insights app id, API-key creation with least privilege (Read telemetry only), `pull-telemetry` cron example (Task Scheduler `.cmd` wrapper like the capture-ship recipe), threshold config JSON block, the batch JSON contract for hand-rolled exporters, and the digest-first posture note (telemetry findings obey the same autoFile hysteresis; they are the trigger layer for scheduling deep captures — the scheduling itself is a later phase).
- [ ] **Step 3: CLAUDE.md** — add `lifecycle telemetry` / `lifecycle pull-telemetry` to the lifecycle command list.
- [ ] **Step 4: Full suite + tsc + biome — PASS.**
- [ ] **Step 5: Commit** — `docs(telemetry): operator recipe; digest visibility test`

---

## Self-Review Notes

- **Spec coverage**: umbrella §Telemetry track — RT0018/RT0005 ingest ✅ (T2/T5), coarse `telemetry:` fingerprints ✅ (existing + T2), lifecycle trigger layer ✅ (T3 sink flow-through), ISV zero-setup story ✅ (T6 docs), job-queue signals: accepted generically (unknown signalIds default warning, D4) with dedicated KQL deferred; deep-capture SCHEDULING explicitly out of scope (later phase, noted in recipe).
- **Type consistency**: `captureKind: "telemetry"` (runs) vs `CaptureKind: "telemetry-batch"` (wire format) — deliberately distinct unions, matching the existing sampling/alcpuprofile split; T1 owns both edits.
- **No second minting path**: only `computeTelemetryFingerprint` mints; parser imports it (T2 step 5 proves stability).
- **The stub AnalysisResult never reaches formatters** — it exists only for `evaluateRun`; web ingest skips analysis/flamegraph for telemetry payloads (T4).
- Placeholder scan: none — every step carries code or an exact assertion target.
