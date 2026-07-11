# Telemetry Config File + ClientType Segmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two follow-ups that first contact with real ISV telemetry (Continia DocumentOutput, 15/15 findings critical under interactive-AL defaults) proved necessary: (A) lifecycle config becomes file-overridable with a DEEP merge — per-app severity thresholds, capture-request tuning — and (B) telemetry signals carry the BC `clientType` dimension so background job-queue methods get different thresholds than interactive sessions instead of blanket-critical noise.

**Architecture:** One config file — the existing `.al-perf/lifecycle.config.json` that sinks already use — gains optional `telemetry` and `captureRequests` blocks, loaded by a new fail-closed validator and deep-merged onto `DEFAULT_LIFECYCLE_CONFIG` (the recorded shallow-merge kill-switch landmine gets defused here). `clientType` rides the telemetry-batch contract as an additive optional field (schemaVersion stays 1); severity lookup tries `${signalId}@${clientType}` before `signalId` before `default`; same-routine signals from different client types merge post-severity into one finding (identity stays routine-level).

**Tech Stack:** Bun, TypeScript, bun:test — al-perf repo conventions (tabs, biome, TDD).

## Global Constraints

- Tabs; biome clean; `bunx tsc --noEmit` clean.
- TDD failing-test-first. `AI_DISABLED=1 bun test <file>`; full suite once before each task's final commit.
- Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- Zero new dependencies.
- **Wire-contract discipline**: `clientType` is ADDITIVE — `TELEMETRY_BATCH_SCHEMA_VERSION` stays 1; batches without it behave byte-identically to today (contract test proves it).
- **Fingerprint stability**: `clientType` NEVER enters the fingerprint — same routine slow in Background and WebClient is ONE finding. Only severity/evidence segment by it.
- **Fail-closed config**: same posture as `loadSinksConfig` (src/lifecycle/sinks/types.ts:200) — mistyped fields throw naming the path, never silently coerce. A missing file is fine (defaults); a malformed file is not.
- **The kill-switch test is mandatory** (recorded debt): a config file containing ONLY `{"telemetry":{"severity":{...}}}` must leave `maxSignalsPerBatch` at 10 000 — the exact shallow-merge failure the capreq review predicted.
- Credential/secret discipline unchanged; the config file carries thresholds only, never tokens (tokenEnv indirection stays as-is for sinks).

## Design Decisions (locked)

- **D1 — One config file.** `telemetry` and `captureRequests` blocks live in `.al-perf/lifecycle.config.json` beside `sinks`. `loadSinksConfig` keeps reading only `sinks`; the new `loadLifecycleConfigFile` reads only `telemetry`/`captureRequests`. Same file, disjoint readers, no coupling.
- **D2 — Deep merge, per-key severity.** `mergeLifecycleConfig(base, patch)`: scalars replace; `telemetry.severity` merges BY KEY (override `RT0018` alone, `RT0005`/`default` survive); `captureRequests` fields replace individually. Arrays (none today) would replace whole.
- **D3 — Severity lookup ladder:** `severity["${signalId}@${clientType}"]` → `severity[signalId]` → `severity.default`. `@`-keys are pure config convention — no wire change, works today via the existing `Record<string, …>` type. `Object.hasOwn` at every rung (prototype guard precedent from telemetry review).
- **D4 — Same-fingerprint merge in the parser.** The puller summarizes by clientType too, so one batch can carry the same routine twice. After severity assignment, the parser merges signals that mint the same fingerprint: severity = max (critical > warning > info), count = sum, maxDurationMs = max, avgDurationMs = weighted mean, evidence lists the per-clientType breakdown. One pattern per fingerprint reaches the stub — evaluateRun never sees duplicate fingerprints in one run.
- **D5 — Puller flag `--client-types <csv>`** filters at the KQL level (`where clientType in (...)`, values validated `^[A-Za-z]+$`); default = no filter. clientType lands in the summarize key and each emitted signal.
- **D6 — Config file reaches every consumer:** CLI `lifecycle` group gains a parent `--config <path>` (default `.al-perf/lifecycle.config.json`, missing-file = defaults) consumed by evaluate/telemetry/pull-telemetry/sync/captures; web ingest reads `AL_PERF_LIFECYCLE_CONFIG` env (optional path) at evaluation time. `sync`'s existing `--config` continues to name the SAME file (sinks reader) — one flag, one file, both readers; keep the single flag and pass the path to both loaders.

---

### Task 1: `mergeLifecycleConfig` + `loadLifecycleConfigFile`

**Files:**
- Create: `src/lifecycle/config-file.ts`
- Test: `test/lifecycle/config-file.test.ts`

**Interfaces:**

```typescript
/** Deep-merge a validated partial onto the defaults (D2). Pure. */
export function mergeLifecycleConfig(
	base: LifecycleConfig,
	patch: LifecycleConfigFilePatch,
): LifecycleConfig;

/** Shape of the file's lifecycle-relevant blocks after validation. */
export interface LifecycleConfigFilePatch {
	telemetry?: {
		maxSignalsPerBatch?: number;
		severity?: Record<string, { warningMs: number; criticalMs: number }>;
	};
	captureRequests?: Partial<LifecycleConfig["captureRequests"]>;
}

/**
 * Read + validate the lifecycle blocks of .al-perf/lifecycle.config.json.
 * Missing file → null (defaults apply). Malformed JSON or mistyped field →
 * throw naming the path and field (fail-closed, loadSinksConfig posture).
 * The `sinks` block is ignored here (loadSinksConfig owns it).
 */
export function loadLifecycleConfigFile(path: string): LifecycleConfigFilePatch | null;
```

Validation rules (each a failing test first): `maxSignalsPerBatch` positive integer; every severity entry has finite positive `warningMs`/`criticalMs` numbers with `warningMs <= criticalMs` (throw naming the key otherwise); severity keys validated `^[A-Za-z0-9_]+(@[A-Za-z]+)?$` (the D3 `@` convention, rejects whitespace/injection garbage); `captureRequests.enabled` boolean via typeof; `minOccurrences`/`ttlDays`/`maxPending` positive integers; `minSeverity` enum. Unknown keys inside the blocks IGNORED (additive evolution). `"enabled": "false"` string → throw (the quoted-boolean trap, sink-config precedent).

- [ ] **Step 1: Failing merge tests** — THE KILL-SWITCH TEST first: `mergeLifecycleConfig(DEFAULT, {telemetry: {severity: {RT0018: {warningMs: 60_000, criticalMs: 600_000}}}})` keeps `maxSignalsPerBatch === 10_000` AND `severity.RT0005`/`severity.default` intact while RT0018 is replaced. Then: scalar replace, captureRequests partial (`{maxPending: 5}` leaves the other four), empty patch = deep-equal defaults, base never mutated (Object.isFrozen-style assertion or before/after deep-equal).
- [ ] **Step 2: Failing loader tests** — missing file null; malformed JSON throws naming path; each validation rule; unknown keys ignored; a full valid file round-trips.
- [ ] **Step 3: Implement both** (~120 lines).
- [ ] **Step 4: Run file, full suite — PASS. Commit** — `feat(lifecycle): file-overridable telemetry and capture-request config with deep merge`

### Task 2: Wire the config file into CLI and web

**Files:**
- Modify: `src/cli/commands/lifecycle.ts` (parent `--config`, thread merged config)
- Modify: `web/handlers/ingest.ts` (AL_PERF_LIFECYCLE_CONFIG env)
- Test: extend `test/lifecycle/cli.test.ts`, `test/lifecycle/sync-cli.test.ts`, `test/web/ingest-telemetry.test.ts`

**Interfaces:**
- `lifecycle --config <path>` parent option (default `.al-perf/lifecycle.config.json`); `sync`'s existing subcommand-level `--config` is REMOVED in favor of the parent flag (breaking flag move — note in commit body; the value semantics are identical and the default path unchanged, so documented invocations keep working).
- Every subcommand that evaluates or scans builds `config = mergeLifecycleConfig(DEFAULT_LIFECYCLE_CONFIG, loadLifecycleConfigFile(opts.config) ?? {})` and passes it: `evaluate` (merged with the existing `--resolve-after` patch — CLI flag wins over file), `telemetry`, `pull-telemetry`, `sync` (trigger scan + capture scan; sinks loader keeps its own read of the same path), `captures` (no config consumer today — skip).
- Web: `handleTelemetryIngest` and the profile lifecycle hook read `process.env.AL_PERF_LIFECYCLE_CONFIG` once per request; set → load/merge (a throw = 500 logged, NOT swallowed into a stored-but-unevaluated state — load BEFORE the keyversion marker is written, alongside the parse), unset → defaults.

- [ ] **Step 1: Failing CLI test** — temp config file raising RT0018 thresholds; `lifecycle --config <file> telemetry batch.json` on a 15s-max signal yields a WARNING finding (default would be critical). Precedence test: `--resolve-after 5` beats a file `resolveAfterRuns`… (note: file patch has no resolveAfterRuns field — evaluate's flag patch applies AFTER the file merge; assert flag wins over defaults regardless).
- [ ] **Step 2: Failing sync test** — file sets `captureRequests.maxPending: 1`; two qualifying findings → 1 created + 1 skippedMaxPending. And: sync still reads sinks from the same file (existing sync-cli tests keep passing with the flag moved to the parent).
- [ ] **Step 3: Failing web test** — AL_PERF_LIFECYCLE_CONFIG pointing at a threshold-raising file changes the stored finding's severity; malformed file → 400/500 (per placement above) and the batch is NOT marked ingested (re-POST works after fixing the file).
- [ ] **Step 4: Implement + run all three test files + full suite — PASS. Commit** — `feat(lifecycle): config file reaches CLI and web ingest`

### Task 3: `clientType` in the contract, parser, and severity ladder

**Files:**
- Modify: `src/types/telemetry.ts` (optional field)
- Modify: `src/core/telemetry-parser.ts` (validation, severity ladder, same-fingerprint merge)
- Test: `test/core/telemetry-contract.test.ts`, `test/core/telemetry-parser.test.ts`

**Interfaces:**

```typescript
export interface TelemetrySignal {
	// ...existing fields...
	/** BC session client type (Background, WebClient, WebServiceAPI, ...). Optional, additive. */
	clientType?: string;
}
```

- Validation: when present, non-empty non-whitespace string matching `^[A-Za-z]+$` (it enters severity-key composition — same injection posture as signalId).
- Severity ladder (D3) with `Object.hasOwn` at each rung; unknown clientType simply falls through to the signalId rung.
- Same-fingerprint merge (D4) AFTER severity assignment: max severity, summed count, max maxDurationMs, weighted-mean avgDurationMs (weight = count; absent avg on any constituent → omit avg), evidence becomes one line per constituent: `Background: 233 × max 76934ms; WebClient: 12 × max 15200ms` style, window unchanged. `involvedMethods`/title from the merged identity (identical by construction).

- [ ] **Step 1: Contract test additions** — schemaVersion still 1; batch WITHOUT clientType parses byte-identically to the pinned pre-change fixture (snapshot the current parse output of an existing fixture BEFORE touching the parser, then assert equality after).
- [ ] **Step 2: Failing parser tests** — `RT0018@Background` config key applies to a Background signal while a WebClient signal of the same routine takes the plain `RT0018` rung; `__proto__` clientType rejected by the regex; merge test: two signals, same routine, different clientTypes → ONE pattern, max severity, summed counts, evidence lists both.
- [ ] **Step 3: Implement. Run files + full suite — PASS. Commit** — `feat(telemetry): clientType dimension — severity ladder and same-routine merge`

### Task 4: Puller + docs

**Files:**
- Modify: `src/lifecycle/appinsights.ts` (KQL, flag, normalization)
- Modify: `src/cli/commands/lifecycle.ts` (`pull-telemetry --client-types`)
- Modify: `docs/telemetry-recipe.md` (clientType section, threshold-tuning-for-job-queue-apps section, config file example)
- Test: `test/lifecycle/appinsights.test.ts`, extend `test/lifecycle/cli.test.ts`

**Interfaces:**
- KQL: `clientType = tostring(customDimensions.clientType)` joins the `summarize ... by` key; `--client-types Background,WebClient` adds `| where clientType in ("Background","WebClient")` (each value validated `^[A-Za-z]+$` BEFORE splicing — same injection posture as signalId; invalid → usage error, zero fetches).
- Normalization: clientType column → `signal.clientType`; absent/empty column → field omitted (old App Insights rows).
- Round-trip: pulled batch with clientTypes validates through the Task-3 parser (test).

Docs (all in telemetry-recipe.md):
- New "Tuning for job-queue apps" section: the DocumentOutput lesson — background methods legitimately run minutes; show a config file example raising `RT0018@Background` to warning 300 000 / critical 1 800 000 while leaving interactive `RT0018` at defaults; state the ladder order.
- Config file section: full `.al-perf/lifecycle.config.json` example with `sinks` + `telemetry` + `captureRequests` coexisting; note the parent `--config` flag move for sync; the honest-docs "no override" sentences from v1 get REPLACED (they're now false — grep for them: §5 and the capture-request-contract.md line about "build-time fork", update both).
- `--client-types` flag in the pull-telemetry flag table.

- [ ] **Step 1: Failing puller tests** (mocked fetch: KQL contains clientType in by-key; filter clause present/absent; validation rejects `Background;drop`; normalization round-trip).
- [ ] **Step 2: Implement puller + flag.**
- [ ] **Step 3: Docs — grep and replace every stale "no config-file override" claim (telemetry-recipe.md AND capture-request-contract.md); diff documented flags against --help.**
- [ ] **Step 4: Full suite + tsc + biome — PASS. Commit** — `feat(telemetry): clientType-aware pulling and threshold tuning docs`

---

## Self-Review Notes

- **Kill-switch defused where recorded**: T1's first test is the exact scenario the capreq final review named (patch with only severity → budget survives).
- **Fingerprint identity untouched**: D4 merge means clientType can never split or duplicate findings; the contract test pins byte-identical behavior for clientType-free batches.
- **Stale honest-docs claims**: v1 shipped several "code defaults only, no override" sentences that become FALSE with this plan — T4 step 3 hunts them explicitly (telemetry-recipe.md §5, capture-request-contract.md §1). Leaving one behind would be a docs-vs-code lie of the kind two final reviews already caught.
- **Flag move risk**: sync's `--config` moving to the lifecycle parent is the only breaking surface; default path identical, and sync-cli tests assert the old invocations' behavior via the new flag position.
- **Injection posture**: every string that reaches KQL or a severity-key lookup is regex-validated (`clientType`, `--client-types` values) — same bar the telemetry review set for signalId.
- Type check: `LifecycleConfigFilePatch.captureRequests` uses `Partial<LifecycleConfig["captureRequests"]>` — stays in sync with the source type by construction.
