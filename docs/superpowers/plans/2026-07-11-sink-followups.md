# Sink Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four accepted-debt items from the github-sink final review: recurrence-after-close sink visibility, dead-letter operator observability, bare-URL autolink hardening, and zip-extractor unhandled-rejection guards.

**Architecture:** All additive. One new delivery kind flows through the existing trigger→outbox→adapter pipeline; one new read-only store accessor surfaces in the sync CLI; two hardening tweaks touch single functions.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test.

## Global Constraints

- Tabs for indentation; biome clean; `bunx tsc --noEmit` clean.
- TDD: failing test first for every behavior change.
- Test runs use `AI_DISABLED=1 bun test <file>`; full suite once before final commit.
- Every commit message ends with the trailer:
  `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- Digest-first posture unchanged: no new default-on outbound behavior. The new comment kind only fires for findings that ALREADY have an issue mapping.
- Escaping changes must not weaken the existing 9-char escape set or fenceBlock; all existing injection tests stay green.

---

### Task 1: `comment-recurred` delivery kind (recurrence after human close)

**Problem (final review, github-sink):** when a human closes an issue and the finding recurs, evaluate emits `filed-fresh`, but the persisted issue mapping suppresses `create-issue` forever and no comment kind matches — the recurrence is sink-invisible (digest-only).

**Files:**
- Modify: `src/lifecycle/sinks/types.ts` (SinkDeliveryKind union)
- Modify: `src/lifecycle/sinks/triggers.ts` (new rule)
- Modify: `src/lifecycle/sinks/github.ts` (render + dispatch branch)
- Test: `test/lifecycle/sinks/triggers.test.ts`, `test/lifecycle/sinks/github.test.ts`

**Interfaces:**
- Produces: `"comment-recurred"` member of `SinkDeliveryKind`; dedupe key grammar `github:comment-recurred:<eventId>` (event-scoped, matching comment-regressed/comment-resolved).

**Steps:**
- [ ] Failing trigger test: seed a finding WITH an issue mapping, log a `filed-fresh` event, run `processEventsForSinks` with autoFile OFF — assert one outbox row of kind `comment-recurred` with dedupe key `github:comment-recurred:<eventId>`. Negative: `filed-fresh` WITHOUT a mapping enqueues nothing (autoFile off) — the existing create path already covers autoFile-on.
- [ ] Add `"comment-recurred"` to the union in types.ts.
- [ ] Trigger rule in triggers.ts, alongside the comment-regressed block:

```typescript
if (event.event === "filed-fresh" && mapping) {
	if (
		enqueue(
			row,
			event,
			"comment-recurred",
			`${SINK}:comment-recurred:${event.id}`,
		)
	) {
		enqueued++;
	}
}
```

- [ ] Failing adapter test: a `comment-recurred` delivery for a mapped fingerprint POSTs to `/repos/{repo}/issues/{n}/comments` with a body that states the finding recurred after the issue was closed; body content passes through the same escaping as other comments (inject `[x](y)` in title, assert neutralized).
- [ ] Adapter: add `renderRecurredComment(f)` (same escaping helpers as renderRegressedComment; body notes recurrence after close, includes severity, occurrence count, lastSeenAt) and extend the comment dispatch branch to include `"comment-recurred"`.
- [ ] Run both test files, then commit: `feat(sinks): comment-recurred delivery for recurrence after human close`

### Task 2: `listDeadOutbox` accessor + sync CLI dead-letter surfacing

**Problem:** DrainReport is counts-only; a dead-lettered row is invisible to operators without hand SQL.

**Files:**
- Modify: `src/lifecycle/store.ts` (accessor)
- Modify: `src/cli/commands/lifecycle.ts` (sync output)
- Test: `test/lifecycle/store.test.ts` (or sinks/store-v2.test.ts, wherever outbox accessors are tested), `test/lifecycle/sync-cli.test.ts`

**Interfaces:**
- Produces: `listDeadOutbox(sink?: string): OutboxRow[]` on LifecycleStore — SELECT rows WHERE status = 'dead' (filtered by sink when given), ordered by id, reusing the existing OutboxRow mapping (includes attempts, lastError).

**Steps:**
- [ ] Failing store test: enqueue a row, `markOutboxDead(id, "boom")`, assert `listDeadOutbox("github")` returns it with status "dead", lastError "boom"; a pending row is not returned; `listDeadOutbox()` with no arg returns dead rows across sinks.
- [ ] Implement accessor next to listPendingOutbox.
- [ ] Failing sync-cli test: with a dead row present, `lifecycle sync --dry-run -f json` output includes a `deadLetters` array with `{ id, kind, dedupeKey, attempts, lastError }` (token/no-network guarantees unchanged — reuse the existing test harness). Text format prints a `Dead letters:` section only when nonempty.
- [ ] Wire into the sync action: after (or instead of, under dry-run) the drain, query `listDeadOutbox("github")` and include in both formats. lastError values are operator-trusted local data — print verbatim, but NEVER include payload JSON (may embed profile-derived text).
- [ ] Run covering tests, then commit: `feat(lifecycle): surface dead-lettered outbox rows in sync output`

### Task 3: bare-URL autolink hardening in escapeInline

**Problem (final review, accepted-optional):** GFM autolinks bare `https://…` and `www.…` even with the 9-char escape set — attacker-controlled field values can render as live links without needing brackets.

**Files:**
- Modify: `src/lifecycle/sinks/github.ts` (escapeInline only)
- Test: `test/lifecycle/sinks/github.test.ts`

**Steps:**
- [ ] Failing tests: `escapeInline("see https://evil.example/x")` contains no `://` substring; `escapeInline("visit www.evil.example")` contains no `www.` substring; rendered issue body for a title containing a bare URL has no autolinkable form. Existing 9-char + fence tests stay green.
- [ ] Append two defang steps AFTER the existing entity replacements (entities decode after linkification, so the text displays identically but never autolinks):

```typescript
.replace(/:\/\//g, ":&#47;&#47;")
.replace(/www\./gi, "www&#46;")
```

- [ ] Run github.test.ts, then commit: `fix(sinks): defang bare-URL and www autolinks in escaped fields`

### Task 4: zip-extractor unawaited stream rejection guards

**Problem (logged follow-up):** `src/source/zip-extractor.ts:154-155` calls `writer.write(...)` and `writer.close()` without awaiting or attaching rejection handlers; a corrupt deflate stream can reject those promises out-of-band, crashing Bun with an unhandled rejection instead of surfacing the existing inflate error path.

**Files:**
- Modify: `src/source/zip-extractor.ts`
- Test: `test/source/zip-extractor.test.ts` or `test/source/zip-security.test.ts` (whichever already covers corrupt-deflate input; add there)

**Steps:**
- [ ] Failing/regression test: extracting an entry whose deflate stream is corrupt rejects with the extractor's own error (not an unhandled rejection). If the suite already has a corrupt-zip fixture, extend it; otherwise construct a minimal zip entry with garbage compressed bytes.
- [ ] Guard the two calls — swallow their rejections so the error surfaces solely through the reader path, which already handles it:

```typescript
writer.write(compressedData as BufferSource).catch(() => {});
writer.close().catch(() => {});
```

- [ ] Run the zip tests, then commit: `fix(source): guard unawaited zip writer promises against unhandled rejection`

---

## Self-Review Notes

- Task 1's dedupe key is event-scoped (recurrence can legitimately repeat); create remains fingerprint-scoped. Consistent with existing grammar.
- Task 2 deliberately excludes payload JSON from operator output (attacker-influenceable).
- Task 3 keeps escapeInline a pure string pipeline; no behavior change for text without URLs.
- Task 4 changes no success-path semantics; the reader loop already propagates inflate errors.
