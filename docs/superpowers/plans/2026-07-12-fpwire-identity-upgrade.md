# fpwire Phase-2: Identity-Upgrade Migration Emission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the fpwire phase-2 gap: `fuseProfile` re-mints pattern fingerprints in place (fallback key → stable routine identity) but emits NO fingerprint migration, so a finding stored under its old fallback fingerprint becomes a DUPLICATE when a later fused run upgrades its identity, instead of the lifecycle store rekeying the existing finding. This plan captures the before→after fingerprint pairs at the re-mint choke point and wires them into the lifecycle apply path as `identity-upgrade` migrations. It also closes the recorded debt that `applyFingerprintMigration` rekeys `sink_issue_map` but NOT `capture_requests` (same migration mechanics, same blast radius).

**Architecture:** `fingerprintPatterns` (src/lifecycle/wire.ts) gains an optional collector that records each pattern whose fingerprint actually CHANGED as a `{from, to}` pair; `fuseProfile` surfaces these on its result; the CLI/analyze lifecycle path applies them via `applyFingerprintMigration(tenant, migration, now)` with reason `identity-upgrade` BEFORE `evaluateRun` consumes the upgraded fingerprints — so the existing finding is renamed to the new identity, then seen again under it (one continuous history, no duplicate). `applyFingerprintMigration` is extended to also rekey `capture_requests.fingerprint`.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test — al-perf conventions (tabs, biome, TDD).

## Global Constraints

- Tabs; biome clean; `bunx tsc --noEmit` clean.
- TDD failing-test-first. `AI_DISABLED=1 bun test <file>`; full suite once before each task's final commit.
- Commit trailer: `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- Zero new deps.
- **Non-fusion path byte-unchanged**: `fingerprintPatterns` without the collector behaves exactly as today; `fuseProfile` with no opts.patterns emits no migrations. Fusion is opt-in; a non-fused analyze must produce identical output and identical lifecycle behavior.
- **No false migrations**: only patterns whose fingerprint STRING actually changed (fallback→stable, or stable→different-stable) are recorded. An anchor that re-mints to the same value emits nothing.
- **Migration application is idempotent + transactional** — reuse the existing `applyFingerprintMigration` (already one transaction with full audit); a re-run of the same fused analyze re-applies as `no-op` (the from-fingerprint no longer exists), never duplicates or errors.
- **Capture-request rekey obeys the same collision discipline** the sink_issue_map merge branch already uses (partial-unique / active-only), so a rekey into an existing active request for the to-fingerprint doesn't PK-collide.

## Design Decisions (locked)

- **D1 — Collector, not return-value rewrite.** `fingerprintPatterns(patterns, methods, attributions?, collector?)` — `collector` is an optional `IdentityUpgrade[]` array the function pushes `{patternId, from, to}` onto for each changed fingerprint. Existing 3-arg callers unaffected.
- **D2 — Migrations surface on FuseResult**, not on AnalysisResult meta (fusion is the only producer; keeping it off the canonical meta preserves the "output byte-unchanged without fusion" contract). `FuseResult.identityUpgrades?: IdentityUpgrade[]`.
- **D3 — Application at the analyze lifecycle choke point** (where evaluateRun is called with a fused result AND a lifecycle store is present — the CLI analyze `--source` + lifecycle path, and the web ingest fusion path if one exists). Apply BEFORE evaluateRun. Where fusion ran but NO lifecycle store is in play (plain analyze to stdout), the upgrades are computed and ignored — harmless.
- **D4 — Reason `identity-upgrade`** (already in FingerprintMigrationReason). The `from` is the fallback-key FindingFingerprint, `to` is the stable one; both reconstructed as FindingFingerprint objects (not just strings) since applyFingerprintMigration takes a FingerprintMigration.
- **D5 — capture_requests rekey** added to applyFingerprintMigration's rename AND merge branches, mirroring the sink_issue_map treatment exactly (rename: UPDATE OR REPLACE-style guard; merge: repoint-or-delete per active-request uniqueness).

---

### Task 1: `applyFingerprintMigration` rekeys `capture_requests` (the recorded debt)

**Files:**
- Modify: `src/lifecycle/store.ts` (applyFingerprintMigration rename + merge branches)
- Test: `test/lifecycle/migrations.test.ts` (extend the fingerprint-migration tests)

**Interfaces:** no signature change; applyFingerprintMigration additionally rekeys `capture_requests.fingerprint` for the tenant.

Behaviors (each failing-first):
- Rename: a tenant with an ACTIVE capture request under the from-fingerprint → after applyFingerprintMigration("renamed"), the request's fingerprint is the to-value; the request stays active/claimed as it was. Guard the partial-unique `idx_capture_requests_active (tenant, fingerprint)` WHERE active: if an active request already exists under the to-fingerprint, the rename must not PK-collide — mirror the sink_issue_map rename's UPDATE OR REPLACE choice (from-row is the live one; the pre-existing to-row is stale/other and loses, OR — safer for capture_requests since a lost request just re-files next sync — repoint the from-row and let the constraint drop the loser; pick the one that can't throw and document it).
- Merge: from-fingerprint closed/merged into to → capture_requests under from repoint to to if no active to-request exists, else the from-request is cancelled (a duplicate capture ask for the same routine is wasteful, not harmful — D5 of the capreq plan). 
- Fulfilled/expired/cancelled capture requests under the from-fingerprint: rekey too (historical accuracy) OR leave (terminal, never re-selected) — pick and test; leaving is acceptable since only ACTIVE rows are ever matched, but the fingerprint column should stay coherent — rekey all rows for the tenant+from, it's simpler and correct.
- No-op migration (from==to or from absent): capture_requests untouched.

- [ ] TDD; full suite; commit — `fix(lifecycle): rekey capture_requests on fingerprint migration`

### Task 2: `fingerprintPatterns` collector + `fuseProfile` surfacing

**Files:**
- Modify: `src/lifecycle/wire.ts` (collector param), `src/semantic/fuse.ts` (thread collector, surface on FuseResult), `src/semantic/fuse.ts` or types (IdentityUpgrade type + FuseResult field)
- Test: `test/lifecycle/wire.test.ts`, `test/semantic/fuse.e2e.test.ts` (or wherever fuseProfile is tested)

**Interfaces:**

```typescript
export interface IdentityUpgrade {
	patternId: string;
	from: FindingFingerprint; // the pre-upgrade fingerprint (fallback key)
	to: FindingFingerprint;   // the upgraded stable identity
}
// wire.ts:
export function fingerprintPatterns(
	patterns: DetectedPattern[],
	methods: MethodBreakdown[],
	attributions?: Map<string, SemanticAttribution>,
	collector?: IdentityUpgrade[],
): void;
// fuse.ts FuseResult gains:
//   identityUpgrades?: IdentityUpgrade[];
```

Behaviors:
- fingerprintPatterns captures the OLD p.fingerprint before overwrite; if the new value differs, push {patternId: p.id, from: <parsed old>, to: <new>}. If the old fingerprint was ABSENT (pattern never fingerprinted before this call — e.g. first fusion in the same process), NO migration (there's nothing stored to rekey; it's a first-mint, not an upgrade) — test this explicitly.
- Reconstructing `from`/`to` as FindingFingerprint objects: parse the fingerprint string back (namespace + hex + algoVersion) — add a small `parseFingerprint(s): FindingFingerprint` helper if none exists (check fingerprint.ts first; formatFingerprint's inverse). from/to carry the pattern namespace.
- fuseProfile: pass a fresh collector array into fingerprintPatterns, assign to fused.identityUpgrades when non-empty.
- Non-fusion / no-collector callers: unchanged (test an existing 3-arg call still works).

- [ ] TDD; full suite; commit — `feat(semantic): surface identity-upgrade fingerprint migrations from fuseProfile`

### Task 3: Apply identity upgrades in the lifecycle path + e2e

**Files:**
- Modify: the analyze→lifecycle wiring (find where a FuseResult's patterns reach evaluateRun with a store — likely src/cli/commands/analyze.ts or the lifecycle evaluate command; trace it). Apply each identityUpgrade via store.applyFingerprintMigration(tenant, {from, to, reason:"identity-upgrade"}, now) BEFORE evaluateRun.
- Modify: `docs/` — a short note in the lifecycle/fusion docs that identity upgrades rekey rather than duplicate.
- Test: `test/lifecycle/wire-fuse.integration.test.ts` (end-to-end: evaluate a finding under a fallback fingerprint; re-evaluate the SAME finding via a fused run that upgrades the anchor; assert ONE finding with continuous history — occurrenceCount 2, not two findings; and any sink issue-mapping / capture request under the old fingerprint followed).

Behaviors (the payoff test):
- Run 1: non-fused (or fused-without-match) evaluate → finding stored under fallback fingerprint F1, occurrenceCount 1.
- Run 2: fused evaluate where the anchor now confidently matches → identityUpgrade {F1→F2} applied, then evaluateRun sees the pattern under F2 → the SAME finding (rekeyed to F2) gets occurrenceCount 2, state advances normally; NO second finding at F1 or F2.
- A capture_request and a sink_issue_map row that existed under F1 now key to F2 (ties Task 1 + the existing sink rekey into the same story).
- Idempotency: re-running Run 2 → the migration is a no-op (F1 gone), the finding is just seen again, no error.
- No-store path: fusion runs, upgrades computed, no store → nothing applied, output identical.

- [ ] TDD; full suite + tsc; commit — `feat(lifecycle): apply identity-upgrade migrations before fused evaluation`

---

## Self-Review Notes
- The whole point: a confidently-matched anchor upgrade must CONTINUE a finding's history, not fork it. Task 3's payoff test is the proof.
- Reuses applyFingerprintMigration wholesale (transactional, audited, viaMigration-guarded so the upgrade doesn't trip sink mass-transition storms) — no new migration machinery.
- Task 1 (capture_requests rekey) is sequenced first so Task 3's e2e can assert the capture-request-follows behavior on a complete applyFingerprintMigration.
- Non-fusion byte-unchanged is the invariant; every task guards it.
- parseFingerprint round-trip: verify formatFingerprint's format (`namespace:hex`) parses back losslessly incl. algoVersion (it may live only in the object, not the string — if so, carry algoVersion from FINGERPRINT_ALGO_VERSION at parse, matching how the patterns were minted).
