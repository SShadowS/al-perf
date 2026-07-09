# BC Performance Observability Platform — Umbrella Design

**Date:** 2026-07-07 (revised 2026-07-09)
**Status:** Revised after six-lens panel review (`docs/superpowers/reviews/2026-07-09-platform-spec-panel-review.md`) — awaiting re-approval
**Scope:** Umbrella vision spanning al-perf, al-perf-bc, bc-dev-mcp, bc-mdc-converter, al-call-hierarchy. Each sub-project below gets its own spec → plan → implementation cycle. This document defines the architecture, contracts, and phasing they share.

## Goal

Continuous performance observability for Business Central: capture profiles automatically, analyze them with pattern detection + AI + whole-program semantic fusion, and report findings through a stateful lifecycle engine into GitHub Issues and Azure DevOps Work Items, with a small agentic triage layer on top of a deterministic core.

**Product posture:** both self-hosted (Docker) and hosted SaaS (alperf.sshadows.dk), same codebase, config-switched. The hosted posture is gated on the multi-tenant security work in §5 (per-tenant credentials, tenant-keyed stores) — until that lands, hosted mode is a labelled single-tenant POC.

**Honest SaaS scoping (revision):** no capture path reaches BC SaaS *production* today. The platform is therefore phased value-first: everything analysis-side (ir-json, fusion, lifecycle) delivers on OnPrem/container/sandbox captures and manually shipped profiles now, and two SaaS-viable hedges under our own control (cu1924 canary, App Insights telemetry) keep the SaaS story alive without waiting on Microsoft.

## SaaS-Production Capture Matrix

| Capture path | SaaS production | SaaS sandbox | OnPrem/container |
|---|---|---|---|
| Manual profile (page 1911, in-client profiler) | ✅ today | ✅ | ✅ |
| **cu1924 self-profiling canary** (Job Queue runs synthetic workload under `Sampling Performance Profiler`, ships result) | ✅ today | ✅ | ✅ |
| **App Insights telemetry** (RT0018 long-running AL, RT0005 SQL, job-queue signals) | ✅ today | ✅ | ✅ |
| Scheduled Profiler fleet capture (tables 2000000266/2000000265) | ❌ blocked on Microsoft (BC30+ or never) | ❌ | ✅ |
| Snapshot-debugger sampling/instrumentation (port 7083) | ❌ structurally — unsupported on SaaS production by policy | ✅ (Entra ID, roadmap) | ✅ today |

The Microsoft ask targets platform system tables 2000000266 "Performance Profiles" / 2000000265 "Performance Profile Scheduler" (server-team-owned; the realistic grant is a permission-gated facade codeunit, not a scope flip, and it will carry an admin-consent gate). Treated as a monitored external dependency, not a workstream — see Phasing.

## Component Inventory (what exists today)

| Component | Role | Relevant existing capability |
|---|---|---|
| al-perf (this repo) | Analysis hub | 18 detectors, AI deep analysis, batch, gate thresholds, history store (JSON files), web server with `/api/ingest` (auto-ship POC, single shared secret), `SourceIndexCache`, spawns `alsem` (feat/alsem-fusion branch, ~4,100 lines with tests) |
| al-perf-bc | Inside capture | Extends profiler pages 1911/1931/1933; batch analysis of Scheduled Profiler output; auto-ship POC (Job Queue → `/api/ingest`, bearer auth, idempotency keys, RSA/AES encrypted-bundle path). Scheduler fleet capture blocked in SaaS (platform tables OnPrem); cu1924 is Cloud-accessible |
| bc-dev-mcp | Outside capture | Snapshot-debugger client (port 7083): sampling and instrumentation capture; instrumentation returns `.mdc` zip. `src/core/` is a clean library separate from the MCP layer. OnPrem/Basic auth only today; Entra ID is a roadmap item |
| bc-mdc-converter | Conversion | Rust CLI: `.mdc` zip → `.alcpuprofile` (byte-identical to Microsoft's), Firefox profile, or `ir-json` — a lossless per-invocation IR explicitly designed as the al-perf interchange format (integer `schemaVersion`, written versioning policy) |
| al-call-hierarchy | Semantic engine | Whole-program resolved call graph (~0% real-unknown edges on reference workspace): `EventFlow` edges, `ImplicitTrigger` edges, interface dispatch, SARIF findings (`alsem`), graphify export, integration-points report. Consumes AL source + `.alpackages` symbols |
| tree-sitter-al | Grammar | Used by al-perf source correlation and (via al-syntax crate) by al-call-hierarchy |

## Architecture

```
CAPTURE                      INGEST/ANALYZE                    REPORT
─────────                    ──────────────                    ──────
Inside track:                al-perf server (Docker/SaaS)      Lifecycle engine
 al-perf-bc auto-ship  ───►   /api/ingest (versioned,           ├─ GitHub Issues
 (cu1924 canary today;        │  source-kind adapters)          ├─ ADO Work Items
  Scheduled Profiler          ├─ durable analysis queue         └─ deterministic
  if/when Microsoft opens)    │  (SQLite, workers,                 reports/digests
                              │   concurrency caps)
Outside track:                ├─ source registry (versioned,   Agentic triage
 capture orchestrator  ───►   │  raw source OR prebuilt         (scheduled agent,
 (bc-dev-mcp core lib,        │  artifacts)                     needs-triage only,
  instrumentation .mdc        ├─ program-graph cache            read-mostly MCP)
  → ir-json)                  │  (aldump/alsem spawn)
                              ├─ analysis: patterns + fusion
Telemetry track (hedge):      │  + AI (event-driven)
 App Insights adapter  ───►   ├─ history/baselines
 (RT0018/RT0005 signals)      └─ finding store (SQLite,
                                  tenant-keyed)
```

Approach chosen: **hub platform** — al-perf is the center; one ingest API, one Docker deploy — plus an **agentic triage layer** (scoped down from "full agentic ops" in revision; see §4) above the deterministic pipeline. Federated microservices were rejected (ops burden for a solo developer); agentic-as-backbone was rejected (non-deterministic core, per-cycle token cost, weak self-host story).

## 1. Capture Layer — tracks behind one adapter seam

`/api/ingest` is a **capture-source adapter seam**: payload-type discriminator + source-kind metadata, not an if/else over formats. Adding a source (telemetry, BCPT results, a future Microsoft facade) is an adapter, not a redesign.

### Inside track (sampling, SaaS-reach)

Two modes:

- **cu1924 canary (default SaaS mode, works today):** a Job Queue entry starts codeunit 1924 `Sampling Performance Profiler` on its own session, executes a configured representative workload (post a synthetic order, run a report, exercise the ISV's hot paths — optionally a BCPT suite), stops, and ships the `.alcpuprofile` through the existing auto-ship plumbing. Needs nothing from Microsoft. Cannot observe real user sessions — it is a scheduled synthetic canary.
- **Scheduled Profiler fleet capture (upgrade path):** Job Queue ships Scheduled Profiler output with tenant/schedule/session metadata. Blocked on Microsoft (see capture matrix). If granted, verify platform-side retention of table 2000000266 rows and add a "gap detected" health signal sized to it.

Auto-ship scheduler adds jitter (BC Job Queues fire clock-aligned; top-of-the-hour fleet bursts otherwise).

### Outside track (instrumentation, depth — OnPrem/container/sandbox)

**Capture orchestrator**, delivered in two stages: first a documented recipe (cron + bc-dev-mcp core + `bc-mdc-converter --format ir-json` + POST), promoted to a standalone Bun daemon when a real deployment needs scheduling/retry management.

- Config: capture jobs `{ env, auth, kind: instrumentation | sampling, sessionFilter, schedule (cron), duration/stopCondition, size caps }`.
- Cycle: preflight (`snapshotendpointmetadata`) → attach → poll → finish → if `.mdc`: convert to ir-json → POST + metadata to `/api/ingest`. Retries with backoff; idempotency keys; capture state persisted across daemon restarts.
- **"0 sessions captured" is a first-class non-error outcome** — snapshot attach binds "next matching session" and may bind nothing in the window.
- Hard duration/size caps and off-peak guidance in config: instrumentation is not free on the profiled server, and full-verbosity recordings are large. Dev-endpoint enablement on production OnPrem is a customer security decision — deployment docs treat it as one.
- OnPrem/docker first (Basic auth, TLS required off-localhost); Entra ID for SaaS sandboxes later (aligned with the bc-dev-mcp roadmap). Sandbox timings are structural signals, not production benchmarks — results are flagged accordingly.

### Telemetry track (SaaS-production hedge)

App Insights adapter: ingest long-running-AL (RT0018), long-running-SQL (RT0005), and job-queue signals via KQL export or the App Insights REST API. No call trees — telemetry findings enter the lifecycle engine as coarse-grained fingerprints (object/method level) and act as the **trigger layer**: a recurring RT0018 opens a finding and schedules a targeted deep capture (cu1924 canary, sandbox instrumentation, or OnPrem scheduler) to obtain the profile. An ISV gets app-level telemetry fleet-wide by setting `applicationInsightsConnectionString` in app.json — zero per-customer setup, zero Microsoft asks.

### Ingest contract

`/api/ingest` (versioned from day one) accepts:

- `.alcpuprofile` — sampling, lossy aggregate (today's format).
- `ir-json` — instrumentation, lossless per-invocation IR (exact self-times, temporal call tree, exceptions).
- telemetry batches — coarse signals (adapter, later phase).

**Payload budget (revision — measured):** ir-json is ~12.8x larger than the equivalent `.alcpuprofile` (~537 bytes/invocation; 6.07 MB vs 474 KB on the reference capture). The contract therefore mandates gzip/zstd transfer encoding, states an invocation-count/size budget, and requires bounded captures at the source (orchestrator duration/size caps). The parse path must not block the event loop on 100 MB bodies — streaming or worker-side parse.

al-perf core gets an ir-json parser producing a richer `ProcessedProfile`. All detectors run on both; some (repeated-siblings, high-hit-count) use exact counts on ir-json instead of statistical inference. Incomplete captures (`isIncomplete`/`incompleteCount`) are analyzed and flagged, and excluded from lifecycle run-counting.

## 2. Ingest, Analysis Queue, Source Registry, Program-Graph Cache

### Ingest + durable analysis queue

- Auth: **per-tenant credentials — new work, not existing.** Today's implementation is one global shared secret with a caller-supplied `x-tenant-id` header; the revision marks that POC-only. Tenant identity derives from the credential server-side; registration (tenant ↔ public key binding) uses a separate admin credential; key rotation is an explicit audited operation.
- Idempotency: true dedup — a seen idempotency key is a no-op response, never a re-analysis.
- Body: profile payload + metadata (tenant, env, appVersions[], activityId, schedule/job id, capture kind).
- **Flow (designed component, not a phrase):** ingest handler is I/O-only and O(payload) — persist raw payload, enqueue, return 202. SQLite-backed durable job queue; worker processes handle CPU-bound parse/analysis/fusion with a concurrency cap; crash recovery re-queues incomplete jobs. SQLite in WAL mode, writes funneled through the queue owner. Per-tenant ingest/analysis counters recorded from the first release (metering for quotas and any future billing).
- **AI analysis is event-driven:** deep AI runs only on new or regressed fingerprints or `needs-triage` flags — never on every steady-state ingest. Per-tenant spend ceiling.

### Data tiers (revision — resolves the encryption contradiction)

Two explicit tiers, replacing the ambiguous "encrypted at rest" story:

- **Tenant-opaque:** raw profiles and raw source — encrypted to the tenant's public key (POC path); the server cannot read them after ingest. Self-host may disable.
- **Server-readable derived data:** finding fingerprints, per-routine metrics, fusion attributions, baselines — stored in tenant-keyed SQLite, protected by server-held envelope encryption (KMS-style) in hosted mode. This tier is what powers the lifecycle engine, fleet reprocessing, heat maps, and sink bodies. Metadata sidecars (manifest/metrics) are declared part of this tier deliberately.

Consequence: "reanalyzable after a fix / fleet reprocessing after detector upgrades" applies to the derived-data tier universally, and to raw profiles only where the server can read them (self-host, or hosted with an explicit server-held-key opt-in).

### Source registry (hybrid: registry + prebuilt artifacts + ad-hoc fallback)

- `POST /api/sources` — CI pushes on release. Accepts **either** raw source zip + `.alpackages` symbols **or prebuilt artifacts** (tree-sitter `SourceIndex` + aldump/alsem exports keyed by content hash) so hosted mode never has to custody ISV source. Keyed `{tenant, appId, version}` — **tenant is a first-class key** for registry, graph cache, and finding store.
- Two-tier cache: a **global cross-tenant tier for Microsoft-published apps** keyed by artifact/content hash (sourced from BC artifacts/BCApps, not customer pushes — monthly minor updates otherwise thrash per-tenant rebuilds of near-identical base-app graphs), and tenant-isolated storage for customer/ISV apps. Sharing is gated on content hash, never on assertable appId/version.
- On registration, build asynchronously through a **dedicated build queue (concurrency 1–2, content-hash dedup, documented memory ceiling)**. Registry entries have states `pending / built / partial / failed` with a pollable status API; partial = source correlation without fusion.
- Zip handling: hardened unzip library, slip-guard on every entry, entry-count caps, per-request jailed extraction dir; alsem/aldump run sandboxed (resource limits, no network).
- Incoming profiles carry appVersions → auto-match registry entries → fusion enabled. No match → profile-only analysis. Profiles arriving mid-build get profile-only analysis; re-fusion after build completion is a policy decision recorded per deployment mode (constrained by data tiers in hosted mode).
- Ad-hoc fallback: `--source` zip on analyze endpoints keeps working, bypassing the registry.

### Graph cache invariants

- Per-app artifacts build on registration. **Merged multi-app graphs build lazily on first profile presenting that combination** — keyed by the hash of the sorted `{appId, version}` set, queued behind the build queue, with a "fusion pending" flag on early results. (Revision: the original "build on registration only" invariant was contradictory — the combination is unknowable until a profile arrives.)
- Version pinning: analyze against the exact matching version; nearest-lower fallback **bounded to the same major/minor band (configurable)**, flagged in the result, and the actually-matched version recorded in finding provenance.
- LRU eviction by size; content-hash invalidation (same discipline as `.al-profile-cache`).
- Whether the registry holds Microsoft base-app source (available per version from BC artifacts) is measured in sub-project 6: quantify how much of the event graph symbols alone recover before promising event-chain blame inside base-app code.

## 3. Analysis + Semantic Fusion

The profile says *where time goes*; the al-call-hierarchy graph says *why it was called and what depends on it*.

**The join (corrected in revision):** correlation is name-based — `(canonicalObjectType, objectNumber, normalizedRoutineName)` — with explicit confidence buckets (`matched / ambiguous / blind-spot / cold / unkeyable`), as implemented in `src/semantic/correlate.ts`. `stableRoutineId` is emitted by alsem's inventory and adopted *after* a confident match; alsem finding fingerprints are a separate identity space (see §4 namespaces). Downstream consumers (lifecycle) must handle `ambiguous` and `blind-spot` buckets explicitly — ambiguous matches never mint stableRoutineId-based fingerprints.

Fusion outputs, tiered by maturity (new section types in `AnalysisResult`; fleet heat map lands in `BatchAnalysisResult`):

**Tier 1 — product (ships first, CLI-first):**

1. **Runtime-weighted static findings** — alsem SARIF findings ranked by the measured cost of the containing routine (extends the existing `prioritized_findings`). A static finding in cold code is low priority; the same finding on a hot path is critical. The genuine moat: nothing else in the BC ecosystem joins a whole-program resolved graph with measured cost.
2. **AI deep-analysis payload enrichment** — `explain/payloads/call-graph.ts` gains precise static context (publishers, interface dispatch targets, trigger chains), improving 7.1/7.4 code-fix quality.

**Tier 2 — enrichment:**

3. **Implicit-trigger attribution** — `ImplicitTrigger` edges explain calls invisible in source (OnValidate/OnInsert chains).
4. **Event-chain blame** — a hotspot inside an event subscriber walked back along `EventFlow` edges to its publisher. **Confidence-gated on sampling:** per-edge percentage claims require a minimum sample count; at 100 ms sampling a 0.5–5 s activity yields 5–50 samples, so precise blame percentages are reserved for ir-json captures. Sampling output carries confidence markers.

**Tier 3 — prove-then-promote (backlog until validated on real data):**

5. **Fix leverage ranking** — static fan-in × runtime cost. Needs damping heuristics (raw fan-in ranks ubiquitous utility helpers first) — promoted only after those exist.
6. **Edge validation (instrumentation only)** — ir-json exact invocation counts annotate static edges (possible-but-never-taken vs hot); feeds what-if simulation. Instrumentation timings are annotated as overhead-skewed: counts trustworthy, ratios of tiny methods not; what-if math prefers counts × sampled-time hybrids where both capture kinds exist.
7. **Fleet heat map (batch)** — many profiles × one graph → runtime heat over the integration-points report. Requires persisted fusion attributions (see below) and an actual fleet.

**Persistence:** fusion attributions (routine/edge fingerprint, cost, profile ref, tenant, schedule) are written as SQLite rows at analysis time — the heat map is a GROUP BY, never a decrypt-and-scan.

**Execution model:** fusion runs post-analysis (CLI-first; server-side when the registry lands); `alsem`/`aldump` spawned as subprocesses (existing engine-runner pattern, schema-major validation); fusion skipped when no graph matches (degradation intact). Formatter parity cost is real: each new section type needs renderers in all four formatters (`SectionRenderers<T>` enforces this) — sections land incrementally, tier by tier.

## 4. Finding Lifecycle Engine + Sinks + Agentic Triage

### Finding identity (fingerprint contract — standalone, lands before fusion output types)

- **Namespaces:** alsem-originated findings keep their native fingerprint under `alsem:`; pattern findings use `pattern:<hash>`; telemetry findings `telemetry:<hash>`. Identities never collide across origins.
- **Pattern fingerprint:** hash(patternId + routine identity + appId + salient location), where routine identity is `stableRoutineId` when a confident alsem match exists, else the **fallback key** `(appId, canonicalObjectType, objectNumber, normalizedRoutineName)` — so profile-only findings (the common case before source registration) are always fingerprintable. When a source registers later, a migration pass links fallback-key findings to their stableRoutineId identities.
- **Salient location** is pinned to a normalized, capture-kind-independent convention (line conventions differ: ir-json wire lines are 0-based, `.alcpuprofile` uses display lines).
- **`fingerprintAlgoVersion` is stored with every finding.** Algorithm upgrades run a re-fingerprint migration linking old→new; sink adapters guard against mass state transitions caused by an algorithm change (distinct from alert-storm quiet hours).
- **Known limitation:** renaming a routine or changing its signature severs `stableRoutineId` — the old finding would silently resolve and a duplicate would be filed. Mitigations: alsem's differential machinery as rename-detection prior art, plus a manual fingerprint-merge operation exposed via `findings_update`.

### Lifecycle states

States: `new, open, regressed, improving, resolved, closed`, plus a `needs-triage` flag (orthogonal to state). Specified as a **transition table (state × event → state, with guards)** in the sub-project spec — the arrow sketch below is orientation only:

`new → open → regressed | improving → resolved (absent N compatible runs) → closed`. Re-appearance after `resolved` reopens with history; after `closed` (human-confirmed), re-appearance files fresh with a link to the closed item. Agent-permitted transitions are an explicit allow-list (the agent can flag/annotate; it cannot force `resolved` against absence-based evidence).

**"Run" is defined:** a capture from the same (tenant, schedule/job) stream. Absence counts only in runs of a **compatible capture kind that actually exercised the containing app** (profile contains frames in that app) — sampling runs never resolve instrumentation-only findings, and an unexercised activity never resolves anything. Lifecycle evaluation is keyed to profile **capture time** (event time) and idempotent per (fingerprint, profileId) — fleet reprocessing of old profiles cannot resurrect resolved findings or corrupt absence counting.

### Trigger rules (per tenant/schedule, configurable)

- Static: severity-count thresholds (gate semantics: max-critical / max-warning).
- Regression: metric delta vs a rolling baseline. **Baselines are keyed (tenant, schedule, captureKind)** — sampling statistical self-time and ir-json exact ticks are not comparable — **and version-stamped** (platform + base-app + ISV-app versions from ingest metadata). Baselines segment at version boundaries; a shift coinciding with a version change is annotated "environment changed", not "regressed" — monthly BC minor updates must not file false regressions.
- Quiet hours / minimum-interval / hysteresis to prevent alert storms and flapping. Flapping on sampling noise is the top trust risk: an auto-filed bot issue gets one chance with a repo owner. Default posture is conservative — digest first, auto-file only above high-confidence thresholds.

**Data model:** per-routine, per-run metrics table in tenant-keyed SQLite (indices on tenant/schedule/routine/runAt; raw rows 90 days, daily rollups after). The existing JSON-file history store migrates into the same SQLite when the lifecycle engine lands — one persistence system, one owner for baseline computation.

### Sink adapters (v1: GitHub Issues; ADO Work Items second)

`SinkAdapter` is a defined interface owning outbox/retry/idempotency semantics — later sinks (Slack, Teams, email digest) are additive files.

- `new` finding passing a trigger → create issue/work item. Body: markdown finding report (existing formatter sections), fusion context, flamegraph link, AI fix suggestion when available. **All interpolated finding text is escaped and fenced** (no @mentions, no directive syntax); labels/area paths validated against per-tenant allow-lists.
- `regressed`/update → comment on the existing item (fingerprint ↔ issue-id mapping in SQLite). Never duplicate.
- `resolved` → comment "not observed since <date>"; optional auto-close (config, default off).
- **State transitions commit locally; sink delivery is asynchronous outbox rows with retry** (revision: the earlier "commit only after sink acknowledgement" contradicted the outbox pattern and would freeze the lifecycle on a GitHub outage). Per-sink rate limiting and collapse-to-epic live in the outbox, not the agent.
- Config per tenant: repo/org/project, PAT (minimal scopes: issues-only / work-items-only), work-item type, labels/area path.
- Lightweight alternative (self-host): a documented `gh issue create` recipe driven by the JSON digest, for teams that want findings in their own CI with their own thresholds.

### Agentic triage layer (scoped down in revision)

Three of the four originally-agentic duties are deterministic and are delivered as such: weekly fleet review = cron-rendered digest from the finding store; post-fix verification = `compare_profiles` + comment template; escalation-into-epics = grouping query in the outbox. **The agent handles only ambiguous-finding triage** (`needs-triage` flag), on a schedule, with:

- Read-mostly MCP tools (`findings_list` / `findings_get`, `baseline_query`); `findings_update` limited to the transition allow-list; `report_file` jailed to a report directory.
- All finding/issue text treated as data, never instructions (delimited non-instruction context — indirect prompt injection through profile/source-controlled strings is a named threat).
- Human confirmation for outward/irreversible actions; per-run token budget; per-tenant scoping; every tool call logged with inputs/outputs; kill-switch.
- Invariant stated explicitly: **findings never depend on the agent** — the deterministic pipeline is complete without it. Agent prompts versioned in-repo; bring-your-own-key for self-host.

## 5. Security, Error Handling, Testing

### Security

- **Tenant isolation (new work):** per-tenant high-entropy credentials (hashed at rest), tenant derived from credential server-side; separate admin credential for tenant/key registration; all stores (registry, graph cache, finding store, files) tenant-keyed. The current global-secret + `x-tenant-id` model is POC-only and labelled as such.
- **Auth posture stated for every `/api` endpoint** — including today's gaps: `/api/analyze` and `/api/analyze-batch` (unauthenticated LLM cost amplification on hosted) and `/api/record-next-batch` (must be admin-gated or excluded from production builds; Dockerfile sets `NODE_ENV=production`).
- Capture provenance: auto-ship signs (not just encrypts) with the tenant RSA material — spoofed uploads must not be able to poison baselines or drive sink writes.
- Data tiers per §2; sink PATs in a named secret backend with minimal scopes; TLS mandated off-localhost (server and BC connections); per-tenant rate limits and upload quotas; AI spend ceilings.
- **Privacy/PII:** profiles carry user names, session IDs, activity descriptions. PII minimization at capture (strip/pseudonymize, config-controlled); per-tenant retention windows and an erasure API; per-tenant opt-out for sending source to the Anthropic API; audit what full-verbosity `.mdc` contains before retaining it server-side; hosted-EU mode implies data-processor obligations (DPA, residency) — documented before hosted GA. Debug-capture path (`AL_PERF_DEBUG`) falls under the same retention policy.
- Crypto: current RSA-OAEP-SHA1 + AES-256-CBC + encrypt-then-HMAC is sound but dated; move to OAEP-SHA-256/AES-GCM when BC-side AL crypto allows; key rotation procedure specified now (keyVersion exists).

### Error handling

- Capture: retry with backoff; failed conversion keeps the raw `.mdc` for manual recovery (bc-dev-mcp pattern); "0 sessions captured" is a non-error.
- Analysis failure: the profile is stored regardless and is reanalyzable after a fix; fleet reprocessing after detector upgrades applies to the server-readable tier (see §2 data tiers).
- Graph build failure: registry states pending/built/partial/failed, pollable; partial degradation (source correlation without fusion) when only alsem fails; profiles during a build get profile-only analysis.
- Sink failure: outbox rows with retry; lifecycle state never blocks on sinks.
- No graph match: fusion skipped with a flag in the result — never blocks base analysis.

### Retention (one policy, all stores)

Per-tenant quotas; TTLs per artifact class (raw profiles, raw `.mdc`, analysis results, finding occurrences, registry artifacts); registry pruning keeps last K versions per app; graph cache LRU as before.

### Testing

- ir-json fixtures from bc-mdc-converter's validated captures; parser goldens; **contract-pin test for ir-json `schemaVersion`** (mirroring `EXPECTED_*_SCHEMA_VERSION` for alsem).
- Fusion: golden tests over a known workspace plus synthetic profiles; stub `alsem`/`aldump` in unit tests, real-binary smokes assert parse-ability, not counts (established pattern). Registry: version matching, bounded nearest-lower, multi-app merge keys.
- Lifecycle: pure state-machine unit tests against the transition table; storm/dedup/flapping scenarios; event-time replay tests.
- Sinks: mocked HTTP; contract tests; injection-escaping tests. Agent: tool-contract tests.
- Inside-track E2E: `scripts/poc-roundtrip.ts` (exists). Outside-track E2E: docker compose (BC container + orchestrator + server) — **local/self-hosted Windows runner only** (BC server containers are Windows-only); hosted CI stays at mocked/contract level.

## Cross-Repo Contracts

| Contract | Producer | Consumer | Versioning |
|---|---|---|---|
| ir-json | bc-mdc-converter (+ future producers) | al-perf parser | integer `schemaVersion`; platform-owned once a second producer exists |
| alsem inventory/analyze schemas | al-call-hierarchy | al-perf engine-runner | semver; major-match enforced (exists) |
| aldump exports | al-call-hierarchy | al-perf registry builds | semver; major-match |
| `/api/ingest` | al-perf server | al-perf-bc, orchestrator, telemetry adapter | versioned endpoint from day one — field installs lag the server |
| Finding fingerprint | al-perf lifecycle | sinks, agent, migrations | `fingerprintAlgoVersion` per finding |

**Rule: a consumer accepts the current plus previous major of every contract it reads.** Rust binaries (alsem, aldump, bc-mdc-converter) ship as checksummed release artifacts, version-pinned in Dockerfiles, with a startup health handshake extending the schema check.

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Microsoft never opens scheduler tables | real | cu1924 canary + App Insights hedge are the SaaS story; scheduler is upside, not the plan |
| `.mdc`/snapshot endpoint breaks per BC release | recurring | converter version gate; raw `.mdc` retained; outside track is OnPrem-first where reproduction is possible |
| Microsoft Sherlocks commodity features | certain, eventually | invest differentiation only in cross-app semantic fusion + lifecycle loop; plain hotspot views are commodity |
| Lifecycle flapping burns sink trust | high if naive | hysteresis, digest-first default, high-confidence auto-file threshold, version-aware baselines |
| Solo-dev bandwidth vs six repos' churn | structural | value-first phasing (below); recipe-before-daemon; parked tiers; each phase independently shippable |
| ISV source custody blocks hosted adoption | high | prebuilt-artifact registration path; hosted never requires raw source |

## Phasing — value-first (reordered in revision)

Each phase is independently shippable and each gets its own spec → plan → implementation cycle.

1. **ir-json ingestion in al-perf** — parser, richer `ProcessedProfile`, detector upgrades, compression + size budget on ingest. Highest value per week; benefits the plain CLI immediately. (Format spec: bc-mdc-converter `docs/superpowers/specs/2026-07-06-ir-json-format-design.md`.)
2. **Fusion, CLI-first** — land feat/alsem-fusion Tier 1 (runtime-weighted findings + AI payload enrichment) via `--source` + local graph paths; Tier 2 as it proves out. No server registry required. Fingerprint contract lands here (it is needed by fusion output types before the lifecycle exists).
3. **Lifecycle engine + GitHub sink** — fingerprint store in tenant-keyed SQLite (history store migrates in), transition table, version-aware baselines, digest report, GitHub adapter + `gh` recipe. Works on today's `.alcpuprofile` ingestion — this is the product-defining loop, deliberately ahead of server-side fusion.
4. **al-perf-bc canary + auto-ship hardening** — cu1924 self-profiling mode as default SaaS behavior; app split decision (Cloud app vs OnPrem companion — a single app cannot target Cloud with pageextensions on OnPrem source tables); PTE-vs-AppSource distribution decision (ID ranges, HttpClient allowlist onboarding, consent UX). *Attached dependency watch: Microsoft scope request (corrected to tables 2000000266/2000000265; realistic ask is a permission-gated facade; re-check each release wave).*
5. **Capture orchestrator** — recipe first; daemon when a named deployment needs it. Telemetry adapter (App Insights) lands here or earlier if the SaaS hedge becomes urgent. BCPT integration as workload driver.
6. **Server-side registry + fusion at scale** — durable analysis queue, source registry (raw + prebuilt artifacts), combination-graph cache, fleet heat map, multi-tenant security work from §5. The former "largest chunk", now sequenced after the product loop exists to justify it.
7. **Agentic triage** — MCP tools over the finding store + scheduled triage agent, per §4 scope.

## Decisions log

From brainstorm (2026-07-07):

- Audience/hosting: product both ways — Docker self-host and hosted SaaS, config-switched.
- Capture: both tracks (inside sampling + outside instrumentation).
- Source acquisition: hybrid — versioned registry with ad-hoc zip fallback.
- Trigger model: full lifecycle engine (fingerprints, dedup, regression baselines, auto-close candidates).
- Sinks v1: GitHub Issues + ADO Work Items (generic webhook and email digest deferred).
- Architecture: hub platform + agentic layer above a deterministic pipeline.

From panel-review revision (2026-07-09):

- SaaS capture matrix added; cu1924 canary and App Insights telemetry adopted as SaaS hedges; Microsoft scheduler ask reclassified as a monitored dependency.
- Data model split into tenant-opaque vs server-readable tiers (resolves encryption vs reprocessing contradiction).
- Merged graphs build lazily on first combination, keyed by app-set hash (resolves registration-build contradiction).
- Fusion join description corrected to the implemented name-based correlate with confidence buckets; fusion outputs tiered (product / enrichment / prove-then-promote); sampling claims confidence-gated.
- Fingerprint contract extracted, versioned, with profile-only fallback key and migration story.
- "Run"/absence defined; baselines keyed by captureKind and version-stamped; sink ack-gating dropped in favor of pure outbox; ADO sink demoted to second.
- Agentic ops scoped down to triage-only over a deterministic reporting core (prompt-injection and blast-radius guardrails specified).
- Per-tenant credentials, endpoint auth posture, retention/PII/GDPR, cross-repo contracts table, and risk register added.
- Phasing reordered value-first: lifecycle ahead of server-side fusion; fusion ships CLI-first from the existing branch; orchestrator recipe-before-daemon.
