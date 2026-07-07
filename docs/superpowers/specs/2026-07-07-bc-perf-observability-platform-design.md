# BC Performance Observability Platform — Umbrella Design

**Date:** 2026-07-07
**Status:** Approved (brainstorm complete)
**Scope:** Umbrella vision spanning al-perf, al-perf-bc, bc-dev-mcp, bc-mdc-converter, al-call-hierarchy. Each sub-project below gets its own spec → plan → implementation cycle. This document defines the architecture, contracts, and phasing they share.

## Goal

Continuous performance observability for Business Central: capture profiles automatically (scheduled, both inside BC and from the outside), analyze them with pattern detection + AI + whole-program semantic fusion, and report findings through a stateful lifecycle engine into GitHub Issues and Azure DevOps Work Items, with an agentic ops layer on top.

**Product posture:** both self-hosted (Docker) and hosted SaaS (alperf.sshadows.dk), same codebase, config-switched.

## Component Inventory (what exists today)

| Component | Role | Relevant existing capability |
|---|---|---|
| al-perf (this repo) | Analysis hub | 18 detectors, AI deep analysis, batch, gate thresholds, history store, web server with `/api/ingest` (auto-ship POC), `SourceIndexCache`, spawns `alsem` (feat/alsem-fusion branch) |
| al-perf-bc | Inside capture | Extends profiler pages 1911/1931/1933; batch analysis of Scheduled Profiler output; auto-ship POC (Job Queue → `/api/ingest`, bearer auth, idempotency keys, RSA/AES encrypted-bundle path). Blocked in SaaS: tables 1924/1932, pages 1931/1933 are OnPrem scope (`MicrosoftRequest.md`) |
| bc-dev-mcp | Outside capture | Snapshot-debugger client (port 7083): sampling and instrumentation capture; instrumentation returns `.mdc` zip. `src/core/` is a clean library separate from the MCP layer. OnPrem/Basic auth only today; Entra ID is a roadmap item |
| bc-mdc-converter | Conversion | Rust CLI: `.mdc` zip → `.alcpuprofile` (byte-identical to Microsoft's), Firefox profile, or `ir-json` — a lossless per-invocation IR explicitly designed as the al-perf interchange format |
| al-call-hierarchy | Semantic engine | Whole-program resolved call graph (~0% real-unknown edges on reference workspace): `EventFlow` edges, `ImplicitTrigger` edges, interface dispatch, SARIF findings (`alsem`), graphify export, integration-points report. Consumes AL source + `.alpackages` symbols |
| tree-sitter-al | Grammar | Used by al-perf source correlation and (via al-syntax crate) by al-call-hierarchy |

## Architecture

```
CAPTURE                      INGEST/ANALYZE                    REPORT
─────────                    ──────────────                    ──────
Inside track:                al-perf server (Docker/SaaS)      Lifecycle engine
 al-perf-bc auto-ship  ───►   /api/ingest                       ├─ GitHub Issues
 (Scheduled Profiler,         ├─ source registry (versioned)    ├─ ADO Work Items
  sampling, SaaS-viable)      ├─ program-graph cache            └─ AI triage
                              │   (aldump/alsem spawn)
Outside track:                ├─ analysis: patterns + fusion    Agentic ops layer
 capture orchestrator  ───►   │   + AI deep                     (scheduled Claude
 (bc-dev-mcp core lib,        ├─ history/baselines              agent, MCP)
  instrumentation .mdc        └─ finding store (SQLite)
  → ir-json)
```

Approach chosen: **hub platform** — al-perf is the center; one ingest API, one Docker deploy — **plus a full agentic ops layer** (scheduled Claude agent) above the deterministic pipeline. Federated microservices were rejected (ops burden for a solo developer); agentic-as-backbone was rejected (non-deterministic core, per-cycle token cost, weak self-host story).

## 1. Capture Layer — two tracks, one contract

### Inside track (sampling, SaaS-reach)

al-perf-bc auto-ship, mostly built. Job Queue ships Scheduled Profiler output (sampling `.alcpuprofile`) to `/api/ingest` with tenant/schedule/session metadata (activityId, client type, schedule description, SQL/HTTP counts). SaaS viability depends on Microsoft opening the OnPrem-scoped objects (verification against BC29 artifacts is sub-project 3's first step; more scope requests may follow).

### Outside track (instrumentation, depth)

New **capture orchestrator**: a standalone Bun daemon (new repo or a subfolder of bc-dev-mcp) reusing bc-dev-mcp `src/core/snapshot` as a library — not the MCP layer.

- Config: a list of capture jobs `{ env, auth, kind: instrumentation | sampling, sessionFilter, schedule (cron), duration/stopCondition }`.
- Cycle: attach → poll → finish → if `.mdc`: run `bc-mdc-converter --format ir-json` → POST ir-json + metadata to `/api/ingest`.
- Retries with backoff; idempotency keys (same semantics as auto-ship).
- OnPrem/docker first (Basic auth); Entra ID for SaaS sandboxes later (aligned with the bc-dev-mcp roadmap).

Both tracks are developed in parallel (decision: parallel tracks, not sequential).

### Ingest contract change

`/api/ingest` accepts two payload types:

- `.alcpuprofile` — sampling, lossy aggregate (today's format).
- `ir-json` — instrumentation, lossless per-invocation IR (exact self-times, temporal call tree, exceptions).

al-perf core gets an ir-json parser producing a richer `ProcessedProfile`. All detectors run on both; some (repeated-siblings, high-hit-count) use exact counts on ir-json instead of statistical inference.

## 2. Ingest, Source Registry, Program-Graph Cache

### Ingest

Extends the existing auto-ship endpoint:

- Auth: bearer per tenant (exists). Idempotency-key dedup (exists).
- Body: profile payload (either type) + metadata (tenant, env, appVersions[], activityId, schedule/job id, capture kind).
- Encryption-at-rest path from the POC (RSA/AES bundle) kept for SaaS mode; optional for self-host.
- Flow: ingest → store → queue for analysis → store result → lifecycle engine evaluates.

### Source registry (hybrid: registry + ad-hoc fallback)

- `POST /api/sources` — CI pushes on release: app identity (id + name + version), source zip, `.alpackages` symbols. Keyed `{appId, version}`.
- On registration, build asynchronously: tree-sitter `SourceIndex` (existing `SourceIndexCache`) + al-call-hierarchy program graph (`aldump` exports + `alsem analyze` SARIF), cached to disk keyed by content hash.
- Incoming profiles carry appVersions → auto-match registry entries → fusion enabled. No match → profile-only analysis (graceful-degradation principle preserved).
- Ad-hoc fallback: `--source` zip on analyze endpoints keeps working, bypassing the registry.
- Multi-app: a profile spans base app + ISV apps; the registry can match several apps and the graph is built over the merged workspace (al-call-hierarchy already ingests cross-app dependencies via `.app` symbols).

### Graph cache invariants

- Build on registration, not on first profile (builds are expensive).
- Version pinning: analyze against the exact matching version; nearest-lower fallback allowed but flagged with a warning in the result.
- LRU eviction by size; content-hash invalidation (same discipline as `.al-profile-cache`).

## 3. Analysis + Semantic Fusion

The profile says *where time goes*; the al-call-hierarchy graph says *why it was called and what depends on it*. Fusion joins them on routine identity: al-perf's `stableRoutineId` on one side, alsem fingerprints on the other.

Fusion outputs (new section types in `AnalysisResult`):

1. **Event-chain blame** — a hotspot inside an event subscriber is walked back along `EventFlow` edges to its publisher: "cost triggered by publisher X in app Y; publisher fans out to N subscribers; yours is 80% of that fan-out cost."
2. **Implicit-trigger attribution** — `ImplicitTrigger` edges explain calls invisible in source (OnValidate/OnInsert chains). The profile shows the call; the graph explains the mechanism.
3. **Runtime-weighted static findings** — alsem SARIF findings ranked by the measured cost of the containing routine (extends the existing `prioritized_findings`). A static finding in cold code is low priority; the same finding on a hot path is critical.
4. **Fix leverage ranking** — static fan-in: fixing routine X benefits N distinct call paths; combined with runtime cost this yields a leverage score.
5. **Edge validation (instrumentation only)** — ir-json provides exact invocation counts per call edge; static graph edges are annotated with measured counts (possible-but-never-taken vs hot). Feeds what-if simulation with real numbers.
6. **Fleet heat map (batch)** — many profiles from a schedule × one graph → runtime heat over the integration-points report: which event wirings cost the most across the fleet.

**AI deep-analysis upgrade:** `explain/payloads/call-graph.ts` currently builds its payload from the profile alone; with fusion it includes precise static context (publishers, interface dispatch targets, trigger chains), improving 7.1/7.4 code-fix quality.

**Execution model:** fusion runs server-side post-analysis; `alsem`/`aldump` are spawned as subprocesses (existing engine-runner pattern); fusion is skipped when no graph matches (degradation intact).

## 4. Finding Lifecycle Engine + Sinks + Agentic Ops

### Finding identity

Fingerprint = hash(patternId + stableRoutineId + appId + salient location), version-tolerant (survives line shifts; alsem fingerprint machinery is prior art). Stored in SQLite alongside the existing history store.

### Lifecycle states

`new → open → regressed | improving → resolved (absent N consecutive runs) → closed`. Re-appearance reopens with history intact.

### Trigger rules (per tenant/schedule, configurable)

- Static: severity-count thresholds (gate semantics: max-critical / max-warning).
- Regression: metric delta vs a rolling baseline (routine self-time +X%, new fingerprint appeared, pattern count increased).
- Quiet hours / minimum-interval to prevent alert storms.

### Sink adapters (v1: GitHub Issues + ADO Work Items)

- `new` finding passing a trigger → create issue/work item. Body: markdown finding report (existing markdown formatter sections), fusion context (blame chain), flamegraph link, AI fix suggestion when available.
- `regressed`/update → comment on the existing item (fingerprint ↔ issue-id mapping in SQLite). Never duplicate.
- `resolved` → comment "not observed since <date>"; optional auto-close (config, default off).
- Config per tenant: repo/org/project, PAT, work-item type, labels/area path.

### Agentic ops layer

A scheduled Claude agent (cron / Claude Code scheduled run) with MCP access to the al-profiler tools, the finding store, and the sinks. Duties above the deterministic pipeline:

- Weekly fleet review: trends across tenants, "top 5 things to fix next sprint."
- Triage of ambiguous findings: the deterministic engine flags `needs-triage` instead of auto-filing when confidence is low.
- Post-fix verification: compare profiles before/after a linked commit; comment the verdict on the issue.
- Escalation: many related findings → one epic instead of N issues.

The agent writes through the same sink adapters, so the audit trail is identical. New MCP tools required: `findings_list` / `findings_get` / `findings_update`, `report_file`, `baseline_query`.

## 5. Security, Error Handling, Testing

### Security

- Tenant isolation: bearer per tenant (exists); all stores keyed by tenant.
- SaaS mode: encrypted-bundle at-rest path from the POC; self-host may disable it.
- Sink credentials (PATs): env/config secrets or encrypted at rest — never plaintext in the DB.
- Source registry holds customer IP: at-rest encryption option, per-tenant storage isolation.

### Error handling

- Capture: retry with backoff; failed conversion keeps the raw `.mdc` for manual recovery (bc-dev-mcp pattern).
- Analysis failure: the profile is stored regardless and is reanalyzable after a fix — this also enables fleet reprocessing after detector upgrades.
- Sink failure: outbox queue with retry; finding state transitions commit only after sink acknowledgement.
- No graph match: fusion skipped with a flag in the result — never blocks base analysis.

### Testing

- ir-json fixtures from bc-mdc-converter's validated captures; parser goldens.
- Fusion: golden tests over a known workspace plus synthetic profiles; stub `alsem`/`aldump` in unit tests, real-binary smokes assert parse-ability, not counts (established pattern).
- Lifecycle: pure state-machine unit tests; storm/dedup scenarios.
- Sinks: mocked HTTP; contract tests.
- E2E: docker compose — BC container + orchestrator + server, one full cycle.

## Phasing — six sub-projects

Each gets its own spec → plan → implementation cycle. This document is the umbrella.

1. **ir-json ingestion in al-perf** — parser, richer `ProcessedProfile`, detector upgrades. Unblocks outside-track value. (Format spec already drafted in the bc-mdc-converter repo: `docs/superpowers/specs/2026-07-06-ir-json-format-design.md`.)
2. **Capture orchestrator** — daemon on bc-dev-mcp core, cron jobs, ship to ingest.
3. **al-perf-bc SaaS enablement** — BC29 artifact scope verification (in progress), target Cloud switch, auto-ship hardening; possibly further Microsoft scope requests.
4. **Source registry + graph cache + fusion** — the largest chunk; fusion sections land incrementally (event-chain blame first, leverage ranking later).
5. **Lifecycle engine + GitHub/ADO sinks.**
6. **Agentic ops layer** — MCP tools over the finding store + scheduled agent.

Tracks 1+2 (outside) and 3 (inside) run in parallel; 4–6 stack on top.

## Decisions log (from brainstorm)

- Audience/hosting: product both ways — Docker self-host and hosted SaaS, config-switched.
- Capture: both tracks in parallel (inside sampling + outside instrumentation).
- Source acquisition: hybrid — versioned registry with ad-hoc zip fallback.
- Trigger model: full lifecycle engine (fingerprints, dedup, regression baselines, auto-close candidates).
- Sinks v1: GitHub Issues + ADO Work Items (generic webhook and email digest deferred).
- Architecture: hub platform + full agentic ops layer (A + C).
