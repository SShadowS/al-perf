# Debt-Closure Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the accumulated NON-migration Minors from the session's review loops in one batch: platform-wide `--tenant` case normalization (case-distinct tenants silently split history), sink recurrence-after-close visibility, epic-per-storm dedupe key, and two capreq micro-items. Each is small and independently testable; grouped because they're all lifecycle/CLI polish that would otherwise rot in the ledger.

**Architecture:** Independent fixes across CLI, sinks/outbox, sinks/triggers, and store. Deliberately EXCLUDES anything touching `applyFingerprintMigration` (the parallel fpwire-identity-upgrade stream owns that code) — this branch and that one stay disjoint.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test — al-perf conventions (tabs, biome, TDD).

## Global Constraints

- Tabs; biome clean; `bunx tsc --noEmit` clean.
- TDD failing-test-first. `AI_DISABLED=1 bun test <file>`; full suite once before each task's final commit.
- Commit trailer: `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- Zero new deps.
- **No behavior change beyond each stated fix**; every task guards existing tests.
- **Do NOT touch `applyFingerprintMigration` or `capture_requests` rekey** — a parallel branch owns fingerprint-migration mechanics; a conflict there is the one thing to avoid.

## Design Decisions (locked)

- **D1 — Tenant normalization is centralized, opt-in-safe.** Introduce one `normalizeTenantCode(raw): string` in the lifecycle layer (or reuse web/storage.ts's if it can be imported without a web dependency — if not, duplicate with an origin comment; do NOT import web/ into src/lifecycle). Apply it at the CLI lifecycle boundary (every subcommand's `--tenant`) and at evaluateTelemetryBatch/evaluateRun tenant entry. Lowercase + trim; reject empty after trim. This makes `--tenant Pilot2` and `--tenant pilot2` the same tenant. EXISTING data under a mixed-case tenant is NOT migrated (out of scope; a doc note tells operators to standardize).
- **D2 — Recurrence-after-close is a config-gated re-file option**, default OFF (digest-first posture preserved). When `sinks.github.reopenOnRecurrence: true`, a `filed-fresh` event on a finding with a CLOSED issue mapping enqueues a `comment-recurred` (already exists) AND a reopen action; default (false) keeps today's behavior (comment-recurred only, issue stays closed). Minimal: if reopen is heavy, ship ONLY the config flag + comment-recurred-on-closed already working, and document that reopen is the flag's future extension — but the flag must at least make the recurrence VISIBLE (it already does via comment-recurred; verify and document, don't over-build).
- **D3 — Epic dedupe key includes a storm identity** so two separate collapse storms don't collide into one epic row, while one storm stays one epic. Current key is row-id-based (new epic per storm — actually already correct per the ghsink review; VERIFY on disk first: if the current key already gives one-epic-per-storm, this item is a no-op + a confirming test, NOT a change).
- **D4 — capreq micro-items:** (a) add the create→claim→create dedupe test (the partial-unique index's claimed-blocks-create branch, currently only probed never asserted); (b) the vestigial `now` param on `cancelCaptureRequest` — either drop it (cleaner) or add a `cancelled_at` column that uses it (more complete). Pick DROP unless a cancelled_at timestamp has downstream value; dropping is a signature change so update all callers.

---

### Task 1: Centralized `--tenant` normalization

**Files:**
- Modify: `src/lifecycle/` (add normalizeTenantCode or locate existing), `src/cli/commands/lifecycle.ts` (apply at each subcommand), evaluate/telemetry entry points as needed
- Test: `test/lifecycle/cli.test.ts`, a normalize unit test

Behaviors:
- normalizeTenantCode("Pilot2") === "pilot2"; trims whitespace; throws/rejects empty-after-trim (usage error at the CLI).
- CLI: `lifecycle evaluate ... --tenant ACME` stores under "acme"; a subsequent `--tenant acme` sees the same finding (no split). Test with two casings landing on one finding.
- Existing lowercase invocations unchanged.
- Doc line: mixed-case existing data isn't auto-migrated; standardize on lowercase.

- [ ] TDD; full suite; commit — `fix(lifecycle): normalize --tenant to prevent case-split history`

### Task 2: Sink recurrence-after-close visibility + epic dedupe confirmation

**Files:**
- Modify: `src/lifecycle/sinks/types.ts` (reopenOnRecurrence config, fail-closed validated), `src/lifecycle/sinks/triggers.ts` (recurrence path), possibly `src/lifecycle/sinks/outbox.ts` (epic key — VERIFY FIRST)
- Test: `test/lifecycle/sinks/triggers.test.ts`, `test/lifecycle/sinks/outbox.test.ts`

Behaviors:
- FIRST verify the current epic dedupe key on disk (outbox.ts collapseCreates). If it already yields one-epic-per-storm with distinct storms distinct, add ONE confirming test (two separate storms → two epics; one storm → one) and mark D3 done-by-verification. If it collides, fix per D3 and test.
- reopenOnRecurrence config: typeof-boolean validated (quoted-boolean trap), default false, SINK_DEFAULTS entry. Verify a `filed-fresh` on a closed-mapping finding already enqueues comment-recurred (from the earlier sink-followups work) — assert it; with reopenOnRecurrence true, additionally the recurrence is surfaced per D2 (comment-recurred is the visibility; if a genuine reopen is cheap given the adapter, add it, else document the flag as reserved-for-reopen and keep comment-recurred as the visibility mechanism). Do NOT over-build a reopen HTTP path if it needs new adapter surface — scope it to config + the already-working comment.

- [ ] TDD; full suite; commit — `feat(sinks): reopen-on-recurrence config and epic-per-storm dedupe test`

### Task 3: capreq micro-items

**Files:**
- Modify: `src/lifecycle/store.ts` (drop vestigial `now` from cancelCaptureRequest if chosen), `src/cli/commands/lifecycle.ts` (caller update)
- Test: `test/lifecycle/store.test.ts` (create→claim→create dedupe)

Behaviors:
- create→claim→create: createCaptureRequest returns a row; claimCaptureRequest transitions it to claimed; a second createCaptureRequest for the SAME (tenant, fingerprint) while claimed returns false (active-dup, the partial-unique index covers pending AND claimed). Assert row count stays 1.
- cancelCaptureRequest: drop the unused `now` param (it writes no cancelled_at today); update the CLI caller and any test. If a reviewer prefers keeping it, that's a plan-amendment discussion — default DROP.

- [ ] TDD; full suite + tsc; commit — `refactor(lifecycle): capreq dedupe test and drop vestigial cancel param`

---

## Self-Review Notes
- Every task is independently revertible; grouped only for review efficiency.
- Task 2 leads with VERIFICATION (epic key may already be correct — don't change working code to satisfy a stale ledger note; confirm-with-a-test is a valid outcome).
- The hard boundary: nothing here touches applyFingerprintMigration/capture_requests-rekey — the parallel fpwire branch owns it. If a task seems to need it, STOP and escalate rather than create a merge conflict.
- Tenant normalization is the highest-value item (silent history splits are real, seen this session with Pilot2/pilot2).
