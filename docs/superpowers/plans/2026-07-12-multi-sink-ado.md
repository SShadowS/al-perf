# Multi-Sink Refactor + Azure DevOps Sink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the github-hardcoded sink pipeline into a true multi-sink fan-out over the existing `SinkAdapter` contract, and add Azure DevOps Work Items as a second first-class sink. A tenant can then route findings to GitHub, Azure DevOps, or both — each with its own trigger rules and issue mapping.

**Architecture:** Three coupling points get generalized: `LifecycleSinksConfig.sinks` (currently `{github?}`) gains `azureDevOps?`; `processEventsForSinks` (currently `const SINK="github"`) iterates every ENABLED sink and enqueues per-sink outbox rows with sink-scoped dedupe keys, evaluating each sink's OWN trigger config; `lifecycle sync` creates and drains one adapter per enabled sink. The outbox (`drainOutbox`) and issue-map are ALREADY sink-scoped (`row.sink`, `getIssueMapping(tenant, sink, fp)`) — no change there. The ADO adapter implements the same `SinkAdapter` interface as GitHub, with its own REST client (Work Item Tracking API), PAT auth, and HTML-entity escaping (ADO Description/comment fields are HTML, not markdown — a different escape discipline than GitHub's fenced markdown).

**Tech Stack:** Bun, TypeScript, bun:sqlite, plain fetch (dev.azure.com), bun:test — al-perf conventions (tabs, biome, TDD).

## Global Constraints

- Tabs; biome clean; `bunx tsc --noEmit` clean.
- TDD failing-test-first. `AI_DISABLED=1 bun test <file>`; full suite once before each task's final commit.
- Commit trailer: `Claude-Session: https://claude.ai/code/session_016iRfkowCE7Zb2FcN52rnPp`
- Zero new deps (plain fetch to dev.azure.com; injectable fetchImpl for tests).
- **BACKWARD COMPATIBILITY IS THE INVARIANT.** An existing github-only config MUST produce byte-identical outbox rows, dedupe keys, delivery behavior, and sync output to today. This is the golden test guarding the whole refactor — a github-only tenant sees zero change. Pin it with a snapshot before touching triggers.ts.
- **Credential discipline** (same bar as GitHub): the ADO PAT is read ONLY from `process.env[tokenEnv]` at call time; never logged, never in errors, never in the config file. Missing env = clear operator error naming the env var. `Authorization: Basic base64(":" + PAT)`.
- **Escaping at the last hop, per sink's own rules.** ADO Description/comment bodies are HTML — finding-derived text is HTML-entity-escaped (`& < > "`), NOT markdown-fenced. Injection tests prove @/#/</script>/HTML-tag neutralization. Title is plain text (ADO strips/ignores markup) — still escape control/entity chars defensively.
- **Fail-closed config** for BOTH sink blocks (the loadSinksConfig posture — typeof checks, quoted-boolean trap, enum validation, throw naming the path).

## Design Decisions (locked)

- **D1 — Shared trigger-rule shape.** Extract the sink-independent trigger fields (`enabled`, `autoFile`, `autoFileMinSeverity`, `autoFileAfterRuns`, `autoClose`, `reopenOnRecurrence`, `minMillisBetweenCalls`, `maxPerDrain`, `collapseThreshold`) into a `SinkTriggerConfig` base; `GitHubSinkConfig` and `AzureDevOpsSinkConfig` each extend it with their own destination/auth fields (github: repo, labels; ADO: org, project, workItemType, areaPath, PAT env). SINK_DEFAULTS splits into shared defaults + per-sink destination defaults.
- **D2 — Sink registry, not if/else.** `processEventsForSinks` and `sync` iterate a list of `{name, config}` for every ENABLED sink block (github, azureDevOps). The trigger scan runs its rule evaluation once per sink using that sink's config; enqueues outbox rows with `sink: name` and dedupe key `${name}:<kind>:...`. Two sinks enabled → a qualifying finding enqueues one row per sink.
- **D3 — ADO adapter mirrors GitHub's mechanics** (create-issue→create work item, comment kinds→work-item comment, close-issue→state transition, reopen→state transition back), with the SAME issue-map pre-check (a create for an already-mapped fingerprint is a zero-call ok — crash-mid-drain double-create mitigation). The issue-map's `externalId` holds the work-item id; `externalUrl` the work-item URL.
- **D4 — ADO REST contract** (pin in mocked tests, api-version 7.0):
  - Create: `POST https://dev.azure.com/{org}/{project}/_apis/wit/workitems/${'$'}{workItemType}?api-version=7.0`, `Content-Type: application/json-patch+json`, body = JSON-Patch add ops for `/fields/System.Title`, `/fields/System.Description` (HTML), optional `/fields/System.AreaPath`, `/fields/System.Tags`.
  - Comment: `POST .../workItems/{id}/comments?api-version=7.0-preview.3`, body `{ text: "<html>" }`.
  - Close/reopen: `PATCH .../workitems/{id}?api-version=7.0`, `Content-Type: application/json-patch+json`, body = `[{op:"add", path:"/fields/System.State", value:"Closed"|"Active"}]` (state names configurable — `closedState`/`reopenState` defaults "Closed"/"Active", since process templates differ; document Agile=Closed/Active, Scrum=Done/New, Basic=Done/To Do).
  - Status mapping: 401/403 permanent (auth/permission); 404 permanent (project/item gone); 429 retryable (rate); 5xx retryable; network throw retryable.
- **D5 — Backward-compat golden test FIRST** (T2 step 1): a github-only config's processEventsForSinks output (outbox rows: sink, kind, dedupe_key, payload) is snapshotted, then asserted byte-identical after the multi-sink refactor.

---

### Task 1: Config generalization — `azureDevOps` block + shared trigger shape

**Files:**
- Modify: `src/lifecycle/sinks/types.ts` (SinkTriggerConfig base, AzureDevOpsSinkConfig, LifecycleSinksConfig.sinks gains azureDevOps, SINK_DEFAULTS split, loadSinksConfig validates both, resolveAzureDevOpsConfig)
- Test: `test/lifecycle/sinks/config.test.ts` (or wherever loadSinksConfig is tested)

**Interfaces:**

```typescript
export interface SinkTriggerConfig {
	enabled: boolean;
	autoFile?: boolean;
	autoFileMinSeverity?: "critical" | "warning" | "info";
	autoFileAfterRuns?: number;
	autoClose?: boolean;
	reopenOnRecurrence?: boolean;
	minMillisBetweenCalls?: number;
	maxPerDrain?: number;
	collapseThreshold?: number;
}
export interface GitHubSinkConfig extends SinkTriggerConfig {
	repo: string; tokenEnv?: string; labels?: string[]; labelsAllowList?: string[];
}
export interface AzureDevOpsSinkConfig extends SinkTriggerConfig {
	org: string;            // dev.azure.com/{org}
	project: string;
	tokenEnv?: string;      // default "AZDO_PAT"
	workItemType?: string;  // default "Bug"
	areaPath?: string;      // optional /fields/System.AreaPath
	tags?: string[];        // System.Tags (validated allow-list like github labels)
	tagsAllowList?: string[];
	closedState?: string;   // default "Closed"
	reopenState?: string;   // default "Active"
}
export interface LifecycleSinksConfig {
	sinks: { github?: GitHubSinkConfig; azureDevOps?: AzureDevOpsSinkConfig };
}
```

Validation: azureDevOps block fail-closed — org/project non-empty strings; workItemType/closedState/reopenState non-empty when present; tags allow-list validated; the shared trigger fields validated identically to github's (reuse the requireBoolean/requireNumber/severity-enum helpers). BOTH-absent or `{sinks:{}}` → null (graceful skip, as today). A malformed azureDevOps block throws naming `sinks.azureDevOps.<field>`.

- [ ] TDD: github-only config still loads identically; azureDevOps-only loads; both-present loads; each validation rule; quoted-boolean trap on the shared fields under azureDevOps; missing-sinks-key → null (the telemetry-config-fix behavior, preserved).
- [ ] Full suite; commit — `feat(sinks): azure devops config block and shared trigger-config shape`

### Task 2: Multi-sink `processEventsForSinks` (the refactor — backward-compat critical)

**Files:**
- Modify: `src/lifecycle/sinks/triggers.ts` (iterate enabled sinks; per-sink rule eval; sink-scoped enqueue)
- Test: `test/lifecycle/sinks/triggers.test.ts`

**Interfaces:** `processEventsForSinks(store, config, now?)` signature UNCHANGED; internally it now loops enabled sinks instead of the hardcoded `SINK="github"`.

- [ ] **Step 1 (BEFORE any change): the golden snapshot.** With a github-only config and a fixture of findings/events, capture the exact outbox rows processEventsForSinks produces (sink, kind, dedupe_key, findingId, payload JSON) into a test snapshot. This is D5 — it must stay byte-identical.
- [ ] **Step 2:** refactor: build the enabled-sink list from config.sinks (github and/or azureDevOps); for each event, evaluate the trigger rules PER SINK using that sink's SinkTriggerConfig (autoFile/severity/hysteresis/reopenOnRecurrence/autoClose all read from the per-sink config); enqueue with `sink: name`, dedupe `${name}:<kind>:<...>`. The dedupe grammar for github stays EXACTLY `github:create:...` etc. (name === "github"), so the golden snapshot holds.
- [ ] **Step 3:** new behavior tests: both sinks enabled → a qualifying finding enqueues TWO rows (github:create:... AND azureDevOps:create:...); a sink with autoFile off enqueues no create for it while the other does; comment/close/reopen fan out per sink independently; the whole scan stays ONE transaction (markEventsProcessed once at the end regardless of sink count).
- [ ] **Step 4:** run triggers tests + full suite; the golden snapshot green. Commit — `refactor(sinks): fan out trigger scan across all enabled sinks`

### Task 3: Azure DevOps sink adapter

**Files:**
- Create: `src/lifecycle/sinks/azuredevops.ts`
- Test: `test/lifecycle/sinks/azuredevops.test.ts`

**Interfaces:** `createAzureDevOpsSink(options: {org, project, workItemType, areaPath?, tags, closedState, reopenState, token}): SinkAdapter` — `name: "azureDevOps"`, plain fetch, injectable fetchImpl.

- HTML-escape helper for Description/comment (`& < > "` → entities); Title escaped defensively; tags validated against the allow-list at enqueue (payload carries validated tags) or at render.
- Issue-map pre-check on create kinds (zero-call ok if mapped); comment/close/reopen route by mapping (non-retryable if absent).
- PAT from options.token → `Authorization: Basic base64(":"+token)`; never in errors/logs.
- Status mapping per D4.
- Mocked-HTTP contract tests: pin the create POST (json-patch body shape, api-version, content-type), comment POST, state PATCH. Injection tests: a finding title with `<script>`, `@mention`, `</div>`, `& < >` → all HTML-escaped in the Description/comment body, no raw tag survives. Pre-check test: create for a mapped fingerprint → zero fetch. Auth-leak test: decoy PAT never in any thrown error/output.

- [ ] TDD; full suite; commit — `feat(sinks): azure devops work-item adapter with html escaping and pre-check`

### Task 4: `sync` multi-sink fan-out

**Files:**
- Modify: `src/cli/commands/lifecycle.ts` (sync action: create + drain each enabled sink)
- Test: extend `test/lifecycle/sync-cli.test.ts`

- The sync action, after processEventsForSinks, iterates enabled sinks: for github create the github adapter (token from its tokenEnv), for azureDevOps create the ADO adapter (PAT from its tokenEnv), and `drainOutbox(store, adapter, ...)` per sink (drain is already sink-scoped by `row.sink`). Aggregate the per-sink DrainReport into the output.
- Text output: a per-sink line (`github: delivered N, dead M`; `azureDevOps: ...`). JSON: `drain` becomes a per-sink map or array `{sink, delivered, retried, dead, collapsed}` plus the existing top-level shape kept for github back-compat if feasible (or a documented shape change — note it). Missing a sink's token env → that sink's drain is skipped with a loud stderr line, the OTHER sink still drains (one misconfigured sink must not block the other). Missing sinks config entirely → exit 0, capture scan still runs (the telemetry-config-fix behavior).
- Dry-run: enqueues (triggers) but drains nothing, for all sinks.

- [ ] TDD: both sinks configured → both drain, per-sink report; ADO token missing → ADO skipped loud, github still drains; github-only config → output back-compat (or documented change asserted); dry-run zero deliveries.
- [ ] Full suite + tsc; commit — `feat(cli): sync drains every configured sink`

### Task 5: Docs + recipe

**Files:**
- Create: `docs/lifecycle-ado-recipe.md`
- Modify: `docs/lifecycle-gh-recipe.md` (cross-link: "routing to Azure DevOps instead/as-well? see the ADO recipe; the trigger config is shared"), `CLAUDE.md` (lifecycle line: sinks now github + azureDevOps)
- Test: none new (docs); verify config examples through loadSinksConfig

- ADO recipe: PAT creation (least privilege: Work Items Read & Write only), the config block (org/project/workItemType/areaPath/tags/closedState/reopenState + shared trigger fields), the process-template state-name table (Agile/Scrum/Basic), digest-first posture note (same defaults), the multi-sink story (both blocks coexist, each with independent rules), the confidentiality note (per-customer/ISV tenants — findings carry environment-identifying data into work items).
- Verify every documented config key validates through loadSinksConfig (run the example through it).

- [ ] Docs; full suite + tsc + biome; commit — `docs(sinks): azure devops recipe and multi-sink config reference`

---

## Self-Review Notes
- The refactor's whole risk is backward-compat; D5's golden snapshot (T2 step 1) is the guard — write it FIRST, before touching triggers.ts.
- `SinkAdapter`, `drainOutbox`, and the issue-map are ALREADY sink-scoped — the refactor is config + trigger-scan generalization + sync fan-out, not a rewrite of the delivery machinery.
- ADO escaping is HTML-entity, not markdown-fence — a DIFFERENT discipline than github; the injection tests must target HTML, not markdown fences.
- Per-sink token isolation: one sink's missing PAT must never block the other's drain (T4).
- State-name configurability (closedState/reopenState) is the ADO-specific gotcha — process templates differ; defaults + docs table cover it.
