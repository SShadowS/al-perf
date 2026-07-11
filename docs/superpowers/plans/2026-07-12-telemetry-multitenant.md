# Multi-Tenant Telemetry Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An ISV's App Insights resource receives telemetry from many customer tenants and environments; today `pull-telemetry` collapses them into one bucket, making "slow *where*?" unanswerable and cross-customer counts meaningless. Add an opt-in split: one batch per (customer AAD tenant, environment), each evaluated under its own al-perf tenant via a config-file mapping — per-customer finding isolation falls out of the existing tenant model for free.

**Architecture:** Split is purely a PULLER concern. The wire contract (`telemetry-batch`) stays untouched — batches remain tenant-free, tenant assignment happens at evaluate time exactly as today. In split mode the KQL gains `aadTenantId`/`environmentName` dimensions, rows group into per-customer batches, `telemetry.tenantMap` in the config file maps AAD tenant GUIDs to al-perf tenant codes, and `environmentName` becomes the run STREAM (absence counting is stream-scoped, so prod and sandbox never cross-resolve each other's findings). Non-split behavior stays byte-identical (snapshot-pinned).

**Tech Stack:** Bun, TypeScript, bun:test — al-perf conventions (tabs, biome, TDD).

## Global Constraints

- Tabs; biome clean; `bunx tsc --noEmit` clean.
- TDD failing-test-first. `AI_DISABLED=1 bun test <file>`; full suite once before each task's final commit.
- Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- Zero new dependencies.
- **Non-split mode is byte-identical to today**: KQL strings, batch output, evaluate behavior — pin with a snapshot test BEFORE touching the puller (same discipline as the clientType task).
- **Wire contract untouched**: no new `TelemetrySignal`/`TelemetryBatchDocument` fields; `TELEMETRY_BATCH_SCHEMA_VERSION` stays 1. The split lives entirely in the puller and CLI.
- **Fingerprints unchanged**: identity stays routine-level; the same slow routine at N customers becomes N findings under N al-perf tenants (findings are tenant-keyed in the store — that isolation is the point).
- **Fail-safe unmapped policy**: an AAD tenant absent from the map is SKIPPED by default (loud stderr count), never silently mixed into another tenant's bucket. Mixing customers is the failure mode this plan exists to prevent.
- Injection posture: mapped al-perf tenant codes are operator config but still validated (`^[A-Za-z0-9][A-Za-z0-9-]{0,39}$` — mirrors web/storage.ts TENANT_CODE_RE); AAD tenant GUIDs validated as GUIDs; `environmentName` values from telemetry are UNTRUSTED (they become stream names — store accepts any string, but they flow into digest/CLI output raw: same single-escape discipline, no new surface).

## Design Decisions (locked)

- **D1 — Opt-in flag `--split-by-customer`**, default off. Off = today's fleet-bucket behavior, byte-identical.
- **D2 — tenant = mapped aadTenantId; stream = environmentName** (empty/missing environmentName → stream `"telemetry"`, today's default). Prod and sandbox findings of the same customer stay separate streams under one tenant — absence/resolve never crosses environments.
- **D3 — Mapping in the config file**: `telemetry.tenantMap: Record<aadTenantGuid, alPerfTenantCode>` + `telemetry.unmappedTenantPolicy: "skip" | "fleet"` (default `"skip"`; `"fleet"` buckets unmapped tenants under the `--tenant` flag value, for ISVs mid-migration). Loaded/validated by `loadLifecycleConfigFile`, deep-merged like everything else (per-key on tenantMap).
- **D4 — Split + `--out` writes one file per mapped group**: `<out-without-ext>.<alPerfTenant>.<stream>.json` (stream sanitized for filenames: non `[A-Za-z0-9-]` → `_`). Split + evaluate (no `--out`) fans out one `evaluateTelemetryBatch` per group.
- **D5 — profileId per split batch** stays the existing content-hash convention — distinct groups hash distinctly by construction; no new idempotency scheme.
- **D6 — Confidentiality is documented, not coded**: per-customer tenants put customer-identifying data (environment names, AAD GUIDs) into digests and — if auto-file is ever enabled — GitHub issues. The recipe gains an explicit data-handling note; digest-first defaults already protect it. No code change.

---

### Task 1: Config block — `tenantMap` + `unmappedTenantPolicy`

**Files:**
- Modify: `src/lifecycle/config.ts` (LifecycleConfig.telemetry gains the two fields; DEFAULT: `tenantMap: {}`, `unmappedTenantPolicy: "skip"`)
- Modify: `src/lifecycle/config-file.ts` (LifecycleConfigFilePatch + validation + merge)
- Test: `test/lifecycle/config-file.test.ts` (extend)

**Interfaces:**

```typescript
// LifecycleConfig.telemetry gains:
telemetry: {
	// ...existing maxSignalsPerBatch, severity...
	/** Multi-tenant split (pull-telemetry --split-by-customer): AAD tenant GUID → al-perf tenant code. */
	tenantMap: Record<string, string>;
	/** What to do with telemetry from AAD tenants absent from tenantMap: skip (default, loud) or bucket under the --tenant value. */
	unmappedTenantPolicy: "skip" | "fleet";
},
```

Validation (each a failing test first): tenantMap keys must be GUIDs (`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` — mirror ACTIVITY_ID_RE's shape), throw naming the key otherwise; reserved keys (`__proto__` etc.) — the GUID regex already excludes them, but add the explicit test; values must match the tenant-code regex `^[A-Za-z0-9][A-Za-z0-9-]{0,39}$`, throw naming key AND value; `unmappedTenantPolicy` enum with the quoted-string trap test; unknown keys inside telemetry still ignored. Merge: tenantMap merges PER-KEY (add one customer without restating the map — same rule as severity); policy scalar replaces.

- [ ] **Step 1: Failing merge tests** — per-key tenantMap merge (patch adds one GUID, defaults' empty map + earlier file keys survive… note DEFAULT is `{}` so the interesting case is two-layer: verify patch keys land and non-patched sibling keys from a hypothetical prior merge survive a second merge); policy replace; kill-switch style: tenantMap-only patch leaves severity/maxSignalsPerBatch intact.
- [ ] **Step 2: Failing loader tests** — GUID key validation (bad GUID named), tenant-code value validation (bad value named), policy enum + quoted trap, `__proto__` key rejected (regex), unknown-key tolerance.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run config-file tests + full suite — PASS. Commit** — `feat(lifecycle): tenantMap config for multi-tenant telemetry split`

### Task 2: Puller split mode

**Files:**
- Modify: `src/lifecycle/appinsights.ts` (KQL dimensions in split mode; grouping; policy application)
- Test: `test/lifecycle/appinsights.test.ts` (extend)

**Interfaces:**

```typescript
export interface PullSplitGroup {
	/** al-perf tenant the group maps to (post-tenantMap). */
	tenant: string;
	/** Run stream — environmentName, or "telemetry" when absent (D2). */
	stream: string;
	/** Source dimensions, for logging/filenames. */
	aadTenantId: string;
	environmentName: string | null;
	batch: TelemetryBatchDocument;
}

export interface PullSplitResult {
	groups: PullSplitGroup[];
	/** AAD tenant GUIDs skipped by the "skip" policy, with row counts (loud reporting). */
	skippedTenants: Array<{ aadTenantId: string; signalCount: number }>;
}

/** Split-mode pull. Non-split pullTelemetry keeps its exact current signature and behavior. */
export function pullTelemetrySplit(
	opts: PullOptions & { tenantMap: Record<string, string>; unmappedTenantPolicy: "skip" | "fleet"; fleetTenant: string },
	fetchImpl?: typeof fetch,
): Promise<PullSplitResult>;
```

Behavior (each a failing test, mocked fetch):
1. **Snapshot pin FIRST**: non-split `pullTelemetry`'s generated KQL strings and output batch for the existing fixture are captured before any change and asserted byte-identical after.
2. Split KQL: `aadTenantId = tostring(customDimensions.aadTenantId), environmentName = tostring(customDimensions.environmentName)` in extend AND the summarize by-key (both signal queries); `--client-types` filter still composes.
3. Grouping: rows group by (aadTenantId, environmentName); each group becomes one `TelemetryBatchDocument` (same windowStart/windowEnd, source `"appinsights-api-split"`); signals within a group keep per-clientType rows (Task-3-telcfg merge happens later, in the parser).
4. Mapping: mapped tenant → group with that tenant; unmapped + `"skip"` → into skippedTenants with summed signal count, NO group; unmapped + `"fleet"` → group with tenant = fleetTenant, stream still from environmentName.
5. Empty aadTenantId rows (old schema/on-prem without AAD): treated as unmapped (policy applies) — never crash, never silently attach to a customer.
6. Round-trip: every group's batch validates through `parseTelemetryBatch`.

- [ ] **Steps: snapshot pin → failing tests 2-6 → implement → run appinsights tests + full suite — PASS. Commit** — `feat(telemetry): multi-tenant split pulling with tenantMap`

### Task 3: CLI fan-out + docs

**Files:**
- Modify: `src/cli/commands/lifecycle.ts` (`pull-telemetry --split-by-customer`)
- Modify: `docs/telemetry-recipe.md` (ISV multi-tenant section + confidentiality note)
- Test: extend `test/lifecycle/cli.test.ts`

**Interfaces:**
- `pull-telemetry --split-by-customer` (boolean): requires the config file to contain a non-empty `telemetry.tenantMap` OR `unmappedTenantPolicy: "fleet"` (else usage error explaining both outs, exit 2, zero fetches — a split with an empty skip-policy map would skip 100% of data, which is never what the operator meant).
- Evaluate mode (no `--out`): one `evaluateTelemetryBatch` per group with `{tenant: group.tenant, stream: group.stream, profileId: <content hash>}`; text output one line per group (`tenant/stream: N findings seen`) + skipped-tenant summary line when nonempty; json output `{groups: [{tenant, stream, aadTenantId, environmentName, outcome}], skippedTenants}`.
- `--out` mode: one file per group at `<out-without-ext>.<tenant>.<sanitized-stream>.json` (D4), still ZERO DB access; prints the file list; skipped summary as above.
- `--tenant` flag doubles as the fleet bucket (D3) — help text updated to say so.

Docs (telemetry-recipe.md, new section after §9):
- "ISV multi-tenant pulling": the two personas (ISV resource = many customer tenants; a BC customer's own environment resource = single tenant, split not needed); tenantMap config example with two customers; stream = environmentName semantics (prod/sandbox never cross-resolve); unmapped policy semantics with the skip-by-default rationale; onboarding flow (register al-perf tenant → add GUID to tenantMap → next pull starts filing under it).
- **Confidentiality note (D6)**: per-customer tenants put customer-identifying data into digests, capture requests, and — if auto-file is ever enabled — external issue trackers; digest-first defaults keep it internal; enabling a sink on per-customer tenants is a data-handling decision (processor role), make it deliberately.
- Flag table row; the §5/§11 config examples gain the two new telemetry keys.

- [ ] **Step 1: Failing CLI tests** — split without map/fleet → exit 2 naming both outs, zero fetches; split evaluate fans out (two mocked groups → two DB tenants populated, streams correct); skipped summary printed; `--out` writes suffixed files, no DB.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Docs; diff flags vs --help; verify the documented tenantMap example validates through loadLifecycleConfigFile.**
- [ ] **Step 4: Full suite + tsc + biome — PASS. Commit** — `feat(cli): per-customer telemetry fan-out and ISV multi-tenant docs`

---

## Self-Review Notes

- **Contract untouched**: verified — no types/telemetry.ts changes anywhere in the plan; split output is N standard batches.
- **Isolation reuses what exists**: findings/runs/digest/sink/captures are already tenant-keyed; the plan adds zero isolation code, only correct tenant assignment — which is why the fail-safe unmapped policy matters (assignment is the whole security story).
- **Type consistency**: PullSplitGroup.stream defaulting and file-name sanitization defined once (D2/D4); Task 3 consumes Task 2's exact interface.
- **Snapshot pins on both non-split KQL and batch output** — the byte-identical discipline that caught nothing-yet-but-someday on the clientType task.
- **Empty-aadTenantId edge** (on-prem/old rows) explicitly specified — the realistic garbage case for mixed fleets.
- Placeholder scan: clean.
