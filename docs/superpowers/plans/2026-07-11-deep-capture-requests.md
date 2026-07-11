# Deep-Capture Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the telemetry→profile loop from the umbrella spec: a recurring telemetry finding creates a *capture request* — a durable, deduplicated work item that external capture executors (capture-and-ship recipe, cu1924 canary) can poll and fulfill — and a later profile run that covers the requested routine automatically marks it fulfilled.

**Architecture:** A `capture_requests` table in the lifecycle DB mirrors the proven outbox pattern (durable queue, dedupe keys, status machine, all writes transactional). A trigger scan runs inside `lifecycle sync` (config-gated, sink-independent); a fulfillment hook runs inside `evaluateRun`'s existing transaction using the method index it already builds. al-perf ships the queue + CLI + contract docs; executor-side polling (bc-dev-mcp) is a follow-up in that repo.

**Tech Stack:** Bun, TypeScript, bun:sqlite, commander, bun:test.

## Global Constraints

- Tabs; biome clean; `bunx tsc --noEmit` clean.
- TDD: failing test first. `AI_DISABLED=1 bun test <file>`; full suite once before each task's final commit.
- Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- Zero new dependencies.
- **Transaction discipline** (matches evaluate/triggers/outbox): every multi-write path is one `store.db.transaction()`; a crash never half-applies a scan or fulfillment.
- **Decoupling invariant preserved**: `evaluateRun` stays sink-ignorant; the capture trigger scan runs only at `lifecycle sync` time. The fulfillment hook inside `evaluateRun` is lifecycle-internal state (like absence counting), not a sink.
- **Digest untouched**: the JSON digest contract (11 locked fields) and markdown sections do not change. Operator view is `lifecycle captures list`.
- Schema migration follows Task-1-telemetry's FK-toggle pattern ONLY if a table rebuild is needed — v4 here is purely additive (new table + index), so plain CREATE TABLE in the migration; no rebuild.
- Attacker-influenceable strings (method/object/app names) are stored RAW and escaped only at render hops (digest/sink) — capture CLI output is terminal/JSON, no markdown context, print verbatim.

## Design Decisions (locked)

- **D1 — Queue, not daemon.** al-perf never schedules captures itself; it publishes requests. Executors poll `lifecycle captures list -f json --status pending`, claim, capture, ship. (Umbrella spec: orchestrator daemon is a later promotion.)
- **D2 — Trigger rule (config-gated, default ON but conservative):** a finding qualifies when ALL of: fingerprint namespace `telemetry:`; state in (new, open, regressed); occurrence count ≥ `minOccurrences` (default 3); severity ≥ `minSeverity` (default "warning"); no ACTIVE (pending/claimed) request for the same (tenant, fingerprint); total active requests for the tenant < `maxPending` (default 20, oldest-first wins — log skips to stderr).
- **D3 — Fulfillment is routine-level, automatic:** during `evaluateRun` on a profile run (captureKind sampling|instrumentation, never telemetry), any ACTIVE request whose normalized routine key matches a method-index entry is marked fulfilled with that run's profileId. Key: `(normalizeAppGuid(appId), canonicalObjectType(objectType), objectNumber, normalizeTriggerName(routineName).toLowerCase())` — the same normalization family as `computeTelemetryFingerprint`, so telemetry-minted requests match profile-side routines.
- **D4 — Expiry:** requests expire `ttlDays` (default 14) after `requested_at`; the sync scan sweeps pending/claimed→expired. Expired/fulfilled/cancelled requests do NOT block re-creation (dedupe is against ACTIVE only) — a still-recurring finding re-files after expiry.
- **D5 — Claim is advisory:** `claimed_by` is a free-text executor label for operator visibility; claiming does not lock fulfillment (a profile fulfills a pending OR claimed request). Double-capture is wasteful, not harmful.
- **D6 — Schema v4, additive only.** New table + index; no rebuild of existing tables.

---

### Task 1: Schema v4 — `capture_requests` store layer

**Files:**
- Modify: `src/lifecycle/store.ts` (LIFECYCLE_SCHEMA_VERSION 3→4, migration, row type, methods)
- Test: `test/lifecycle/store.test.ts` (new describe block), `test/lifecycle/migrations.test.ts` (v3→v4 on populated DB)

**Interfaces:**
- Produces (all on `LifecycleStore`):

```typescript
export interface CaptureRequestRow {
	id: number;
	tenant: string;
	fingerprint: string; // telemetry:<16hex> — the requesting finding
	findingId: number;
	// Normalized routine key (D3) — stored pre-normalized at creation time:
	appId: string;
	appName: string | null;
	objectType: string;
	objectId: number;
	methodName: string; // trigger-normalized, lowercased
	reason: string; // human line, e.g. "RT0018 × 5 runs, max 42000ms"
	status: "pending" | "claimed" | "fulfilled" | "expired" | "cancelled";
	requestedAt: string;
	expiresAt: string;
	claimedAt: string | null;
	claimedBy: string | null;
	fulfilledAt: string | null;
	fulfilledByProfileId: string | null;
}

createCaptureRequest(input: Omit<CaptureRequestRow, "id" | "status" | "claimedAt" | "claimedBy" | "fulfilledAt" | "fulfilledByProfileId">): boolean; // false = active duplicate existed (INSERT OR IGNORE via partial-unique semantics — see below)
listCaptureRequests(tenant?: string, status?: CaptureRequestRow["status"]): CaptureRequestRow[]; // ordered by id
countActiveCaptureRequests(tenant: string): number; // pending + claimed
claimCaptureRequest(id: number, claimedBy: string, now: string): boolean; // pending→claimed only
cancelCaptureRequest(id: number, now: string): boolean; // pending|claimed→cancelled
expireCaptureRequests(now: string): number; // pending|claimed with expiresAt <= now → expired; returns count
fulfillMatchingCaptureRequests(tenant: string, routineKeys: Set<string>, profileId: string, now: string): number; // pending|claimed whose appId|objectType|objectId|methodName join-key ∈ routineKeys → fulfilled; returns count
```

- DDL (migration `LIFECYCLE_MIGRATIONS[3]`; SQLite partial unique index enforces one ACTIVE request per finding identity):

```sql
CREATE TABLE capture_requests (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	tenant TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	finding_id INTEGER NOT NULL REFERENCES findings(id),
	app_id TEXT NOT NULL,
	app_name TEXT,
	object_type TEXT NOT NULL,
	object_id INTEGER NOT NULL,
	method_name TEXT NOT NULL,
	reason TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending','claimed','fulfilled','expired','cancelled')),
	requested_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	claimed_at TEXT,
	claimed_by TEXT,
	fulfilled_at TEXT,
	fulfilled_by_profile_id TEXT
);
CREATE UNIQUE INDEX idx_capture_requests_active
	ON capture_requests(tenant, fingerprint)
	WHERE status IN ('pending','claimed');
CREATE INDEX idx_capture_requests_tenant_status
	ON capture_requests(tenant, status);
```

`createCaptureRequest` uses `INSERT OR IGNORE` — the partial unique index makes an active duplicate a no-op; return `changes > 0`. `fulfillMatchingCaptureRequests` selects active rows for the tenant, computes the join key `${app_id}|${object_type}|${object_id}|${method_name}` per row in TS, updates matches — row counts are small (≤ maxPending), no SQL-side join needed.

- [ ] **Step 1: Failing migration test** — build a genuine v3 DB (run real migrations; reuse the fixture helper), migrate to v4, assert `capture_requests` exists, prior data intact, `PRAGMA foreign_key_check` empty, user_version 4.
- [ ] **Step 2: Failing store tests** — create (returns true), duplicate-active create (returns false), create-after-fulfilled (returns true — dedupe is active-only, D4), list filters, claim only from pending (claimed/fulfilled/cancelled/expired all refuse), cancel from pending and claimed, expire sweep respects `expiresAt <= now` boundary, fulfill matches exact join key and skips non-matching tenant.
- [ ] **Step 3: Implement** — bump version, add migration (plain additive — no FK toggle needed, but it runs inside the existing toggle wrapper harmlessly), row mapper, methods. All status transitions are single UPDATE statements with status-guard WHERE clauses (`WHERE id = ? AND status = 'pending'`), returning `changes > 0`.
- [ ] **Step 4: Run migration + store tests, then full lifecycle suite — PASS.**
- [ ] **Step 5: Commit** — `feat(lifecycle): schema v4 — capture request queue`

### Task 2: Trigger scan + config + sync wiring

**Files:**
- Create: `src/lifecycle/capture-triggers.ts`
- Modify: `src/lifecycle/config.ts` (captureRequests block)
- Modify: `src/cli/commands/lifecycle.ts` (sync calls the scan)
- Test: `test/lifecycle/capture-triggers.test.ts`, extend `test/lifecycle/sync-cli.test.ts`

**Interfaces:**
- Config added to `DEFAULT_LIFECYCLE_CONFIG`:

```typescript
captureRequests: {
	enabled: true,
	minOccurrences: 3,
	minSeverity: "warning" as "critical" | "warning" | "info",
	ttlDays: 14,
	maxPending: 20,
},
```

- Produces: `processCaptureTriggers(store: LifecycleStore, config: LifecycleConfig, now?: string): CaptureTriggerReport` where `CaptureTriggerReport = { scanned: number; created: number; expired: number; skippedMaxPending: number }`.

Scan algorithm (whole scan one transaction):
1. `expired = store.expireCaptureRequests(now)`.
2. Candidate findings: `telemetry:`-namespaced, state in (new, open, regressed), for all tenants in the store (add a store query or reuse listFindings filtering in TS — small tables).
3. Per candidate, in `id` order: severity rank ≥ config threshold; `store.countOccurrences(findingId) >= minOccurrences`; `countActiveCaptureRequests(tenant) < maxPending` (else `skippedMaxPending++`, continue); `createCaptureRequest(...)` (false → active dup, not counted).
4. Routine key fields: parse from the finding's latest occurrence context — the telemetry finding's title/involvedMethods carry `${methodName} (${objectType} ${objectId})`; appId comes from the finding row (Task-3-telemetry guaranteed non-empty for telemetry findings). Normalize with the D3 functions at CREATION time so fulfillment is a string-equality join. `reason` = `${patternId-ish signalId}: ${occurrenceCount} runs, severity ${severity}` — derive signalId from the finding's patternId (`telemetry-rt0018` → `RT0018`).
5. `expiresAt = new Date(Date.parse(now) + ttlDays * 86_400_000).toISOString()`.

Sync wiring: in the sync action, run `processCaptureTriggers` BEFORE sink processing, gated on `config.captureRequests.enabled` (and independent of any sink being configured — sync with no sinks config file still scans; adjust the early-exit so a missing sinks config no longer aborts before the capture scan, keeping exit 0 and reporting `captures` in both formats). Output: text gets a `Capture requests: N created, M expired` line when nonzero; json gets `captureRequests: {created, expired, skippedMaxPending}`.

- [ ] **Step 1: Failing trigger tests** — telemetry finding with 3+ occurrences → request created with normalized key fields + correct expiry; 2 occurrences → none; info-severity → none (threshold); pattern-namespaced finding → NEVER (namespace guard); active dup → no second; after expiry sweep → re-created; maxPending cap → skipped counted; resolved/closed states → none.
- [ ] **Step 2: Failing sync-cli test** — sync on a DB with a qualifying finding (no sinks config file present) → exit 0, json contains captureRequests.created 1; dry-run also scans (capture-request creation is local DB state, not delivery — document this in --help text: dry-run skips only sink delivery).
- [ ] **Step 3: Implement scan + config + wiring.**
- [ ] **Step 4: Run both test files + full suite — PASS.**
- [ ] **Step 5: Commit** — `feat(lifecycle): capture-request trigger scan in sync`

### Task 3: Fulfillment hook in evaluateRun

**Files:**
- Modify: `src/lifecycle/evaluate.ts` (hook inside the existing run transaction)
- Test: `test/lifecycle/capture-fulfill.test.ts`

**Interfaces:**
- Consumes: `store.fulfillMatchingCaptureRequests` (Task 1), the method index `evaluateRun` already builds.

Hook placement: inside `evaluateRun`'s `runTx`, after `recordRun` succeeds and the method index exists, ONLY when `run.captureKind !== "telemetry"` and the run is not a duplicate and not incomplete:

```typescript
if (run.captureKind !== "telemetry" && !incomplete) {
	const keys = new Set<string>();
	for (const m of index.values()) {
		keys.add(
			`${normalizeAppGuid(m.appId ?? "")}|${canonicalObjectType(m.objectType)}|${m.objectId}|${normalizeTriggerName(m.functionName).toLowerCase()}`,
		);
	}
	store.fulfillMatchingCaptureRequests(run.tenant, keys, run.profileId, run.captureTime);
}
```

(Adapt field names to the actual method-index entry shape on disk — verify before coding; the normalization calls are the contract.)

- [ ] **Step 1: Failing tests** — seed an active request (via store method) whose key matches a routine in a profile fixture; evaluateRun on that profile → request fulfilled with profileId + captureTime; non-matching routine → stays pending; telemetry batch evaluate → NEVER fulfills (kind guard); incomplete ir-json run → does not fulfill; duplicate run → does not fulfill twice / no error; claimed request also fulfillable (D5).
- [ ] **Step 2: Implement** (guard + key build + call; ~15 lines).
- [ ] **Step 3: Run capture-fulfill + evaluate + telemetry-evaluate test files + full suite — PASS.**
- [ ] **Step 4: Commit** — `feat(lifecycle): auto-fulfill capture requests from matching profile runs`

### Task 4: CLI `captures` group + executor contract docs

**Files:**
- Modify: `src/cli/commands/lifecycle.ts` (captures subgroup)
- Modify: `docs/telemetry-recipe.md` (close-the-loop section)
- Create: `docs/capture-request-contract.md` (executor contract)
- Modify: `CLAUDE.md` (one line)
- Test: extend `test/lifecycle/cli.test.ts` (in-process commander, temp DB)

**Interfaces (CLI, under the existing lifecycle group so `--db` parent option applies):**
- `lifecycle captures list [--tenant <t>] [--status pending|claimed|fulfilled|expired|cancelled] [-f text|json]` — text: cli-table3-style like `lifecycle status`; json: array of CaptureRequestRow (camelCase, verbatim strings).
- `lifecycle captures claim <id> --by <executor> [-f text|json]` — exit 0 on success; exit 1 with clear message when not claimable (wrong status/unknown id).
- `lifecycle captures cancel <id>` — same exit semantics.

Docs:
- `docs/capture-request-contract.md`: the executor loop — poll `list -f json --status pending`, claim with a stable executor name, run the capture against the named app/object/method (capture-and-ship recipe for OnPrem/container, cu1924 canary for SaaS), ship to the SAME tenant, fulfillment is automatic on ingest (routine match), requests expire after ttlDays, claim is advisory (D5), re-poll cadence guidance (align with pull-telemetry cron, e.g. hourly). Include the exact JSON row shape.
- `telemetry-recipe.md` addition: one "Closing the loop" section pointing at the contract doc: pull-telemetry cron → findings → sync scan → captures list → executor → profile arrives → fulfilled.
- CLAUDE.md: add `captures` to the lifecycle command list line.

- [ ] **Step 1: Failing CLI tests** — list renders seeded rows (both formats, json field names exact); claim transitions + exit codes (claim a fulfilled row → exit 1, message names current status); cancel; unknown id → exit 1.
- [ ] **Step 2: Implement CLI.**
- [ ] **Step 3: Docs** (flags diffed against --help output; no secret values; JSON shape matches CaptureRequestRow exactly).
- [ ] **Step 4: Full suite + tsc + biome — PASS.**
- [ ] **Step 5: Commit** — `feat(cli): lifecycle captures queue commands and executor contract docs`

---

## Self-Review Notes

- **Spec coverage:** umbrella "recurring RT0018 opens a finding and schedules a targeted deep capture" — the *scheduling* is the queue + external executor per D1 (spec's own two-stage orchestrator posture); routine-level fulfillment closes the loop measurably. Canary/bc-dev-mcp polling integration = follow-up in those repos, documented in the contract doc.
- **Type consistency:** routine join key uses the same normalization family as computeTelemetryFingerprint (normalizeAppGuid, canonicalObjectType, normalizeTriggerName+lowercase) at BOTH creation (T2) and fulfillment (T3); Task 3 verifies method-index field names on disk before coding.
- **No digest change** anywhere (D-locked contract untouched); operator surface is the CLI.
- **Dedupe correctness:** partial unique index is the single enforcement point; scan-level checks are courtesy counters.
- Placeholder scan: clean — every step names exact assertions or carries code.
- **Known risk to verify in T2:** the finding row must yield objectType/objectId/methodName — telemetry finding titles embed them, but parsing display strings is brittle; PREFER reading the latest occurrence's stored context (occurrences detail JSON carries the SinkFindingContext-shaped fields) — implementer verifies what's actually persisted and picks the structured source; if neither is structured enough, escalate NEEDS_CONTEXT before inventing a title parser.
