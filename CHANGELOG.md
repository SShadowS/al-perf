# Changelog

## 3.0.0 — 2026-07-12

The release that turns al-perf from a profile analyzer into a performance observability platform. A profile analyzer answers "why was this run slow?" and forgets. This release adds a **finding lifecycle engine**: findings get a stable identity, are tracked across runs, and are driven out to the places you already look — GitHub, Azure DevOps, App Insights telemetry.

Two breaking changes; both have a mechanical fix. See below.

### Breaking

- **`lifecycle sync --config` moved to the parent command.** Use `lifecycle --config <path> sync ...` instead of `lifecycle sync --config <path> ...`. The default path and value semantics are unchanged, so documented invocations still work once the flag moves before the subcommand name.
- **Web ingest no longer accepts the shared secret by default.** Clients hitting `/api/ingest` and `/api/profiles` must re-register to obtain a per-tenant token, or the server must be started with `AL_PERF_ALLOW_SHARED_SECRET=1`. The old behavior let any holder of one secret write as any tenant.

The library API is purely additive — no exports were removed or changed.

### Added — finding lifecycle engine

- **Durable findings across runs.** Every finding gets a stable fingerprint and a state machine (`new → open → regressed / improving → resolved → closed`). SQLite-backed, at `.al-perf/lifecycle.db`. A problem that persists is one finding with a history, not a fresh row every run.
- **`lifecycle evaluate`** — analyze a profile and advance finding state.
- **`lifecycle status` / `digest`** — what's open, what regressed, what needs triage.
- **Baselines and absence tracking** — a finding that stops appearing auto-resolves after `resolveAfterRuns` (default 3), so a fixed problem closes itself.

### Added — sinks

- **GitHub sink** — files findings as issues, comments on regression and recurrence, closes on resolution. Configured per-tenant with its own trigger rules.
- **Azure DevOps sink** — the same, as work items.
- **Multi-sink fan-out** — both can run at once, each with independent rules. A sink enabled after a tenant already has history replays that history and picks up the live backlog on its first `sync` (dormant findings included; long-dead ones correctly skipped).
- **Epic collapse** — a storm of new findings collapses into one parent issue rather than flooding the tracker.
- **`lifecycle sync`** — drains every configured sink. Config at `.al-perf/lifecycle.config.json`; each sink's token comes from the env var named by its `tokenEnv`.

### Added — telemetry as a trigger layer

- **App Insights ingestion** (`lifecycle telemetry`, `lifecycle pull-telemetry`) — Business Central telemetry becomes findings, so a slow routine surfaces from production signal rather than waiting for someone to capture a profile.
- **Multi-tenant** — `--split-by-customer` fans a pull out across tenants. Every `--tenant` value is normalized to lowercase at the CLI boundary and in `evaluateRun`.

### Added — deep-capture request queue

- Recurring telemetry findings are coarse: they say a routine is slow, not why. The engine now **files a deep-capture request** — a queue an external executor services (poll → claim → capture → ship), auto-fulfilled when the resulting profile arrives.
- **`lifecycle captures list / claim / cancel / health`** — operate the queue. `health` reports depth, oldest pending, stuck claims and who holds them, and whether you're at the cap.
- **Self-correcting.** A request claimed by an executor that then dies is reclaimed after `claimTtlMinutes` (default 60) and handed to another worker. A `reclaim_count` distinguishes a dead executor from a poison request that kills whatever picks it up.
- **It says so when it jams.** When the executor dies the queue fills to `maxPending` and new requests stop being filed — `sync` warns, `captures health` shows it, and the digest carries a jammed-queue block (only when actually jammed, so the healthy case stays quiet).

### Added — agentic triage

- **`lifecycle triage-agent`** — an optional scheduled LLM pass over needs-triage findings, with allow-listed tools and injection-hardened prompting. The one agentic step in an otherwise deterministic pipeline.

### Added — ir-json ingestion

- Accepts `ir-json`, the lossless per-invocation instrumentation format from `bc-mdc-converter`. Hit counts become **exact invocation counts** rather than statistical inference, so `repeated-siblings` and `high-hit-count` stop guessing. Format is sniffed from content, not extension.

### Added — al-sem source fusion

- Optional correlation against the al-sem semantic engine upgrades a finding's identity from a fallback key to a stable routine anchor, and carries its history across the change rather than forking it.

### Fixed

- **Algorithm-version bumps no longer orphan every finding.** Changing `FINGERPRINT_ALGO_VERSION` changes every fingerprint by design — but it used to silently re-file every live problem as new and strand every existing row in `resolved` forever. `evaluateRun` now refuses to run, naming `lifecycle maintain --purge-stale-fingerprints` as the way forward.
- **`/api/debug/status` reports aggregate counts, not tenant names.** The endpoint is unauthenticated; it now exposes `staleAlgoTenantCount` / `staleAlgoFindingCount` and never a customer identifier.
- **Web ingest stopped claiming success while doing nothing.** A stale-algo tenant used to get one stderr line and a `202 {status:"stored"}`, every ingest, forever. The response now carries `lifecycle: {status:"blocked", reason, remediation}` when the guard fires.

## 2.3.3 — 2026-06-01

### Fixed

- **Upgrade banner auto-hides when AI is active** — Previously the banner rendered unconditionally until manually dismissed, so restoring the `ANTHROPIC_API_KEY` did not remove it. The banner now starts hidden and is shown by `app.js` only when `/api/debug/status` reports `aiEnabled: false`. Added `aiEnabled` to the status endpoint (`true` when `ANTHROPIC_API_KEY` is set and `AI_DISABLED !== "1"`).

## 2.3.2 — 2026-05-25

### Fixed

- **Stale assets behind Cloudflare** — `app.js`/`style.css` were cached ~186 days by Cloudflare with no cache-busting, so returning visitors (e.g. on mobile) kept old assets and never saw the upgrade banner. HTML now stamps local asset refs with `?v=<version>` and is served `Cache-Control: no-cache`, so each release yields fresh asset URLs and affected browsers self-heal on next visit.

## 2.3.1 — 2026-05-25

### Added

- **Deploy/restart detection** — `/api/debug/status` now returns `version` (from `package.json`), `startedAt` (boot timestamp), and `uptimeSec`, so a redeploy/restart is detectable over HTTP and the running version is visible. Existing `debugMode`/`pendingCaptures` fields unchanged.

## 2.3.0 — 2026-05-25

### Added

- **Web upgrade/sponsor banner** — Dismissible top banner announcing the v2 upgrade and offering a single sponsor logo slot. State persisted in `localStorage`.
- **`AI_DISABLED` flag** — Setting `AI_DISABLED=1` skips all AI calls (explain + deep) in the web service, avoiding wasted latency/retries when the API key is unavailable. Startup log reflects the state.

### Fixed

- **Persistent captures + stats** — Debug/consent captures (`DEBUG_DIR`) and `stats.json` now live under the data root (`AL_PERF_DATA_DIR`, `/data` in Docker), so they survive container redeploys instead of landing in the ephemeral container layer.
- **Privacy: no IP in consent captures** — Removed `consentedBy` (visitor IP) from saved consent capture metadata, matching the "anonymously" wording.

## 0.1.0 — 2026-03-05

Initial feature-complete release with 27 analysis capabilities across three tiers.

### Tier 1: Immediate Wins

- **Wall Clock vs CPU Gap Analysis** — Compare wall-clock duration to CPU time for instrumentation profiles, revealing I/O waits and SQL roundtrips
- **Built-in vs Custom Code Separation** — Classify nodes as built-in or custom using `isBuiltinCodeUnitCall`, enabling a "your code only" view
- **Line-Level Hotspot Map** — Break down `positionTicks[]` to produce line-by-line time attribution within methods (instrumentation profiles)
- **Cost Per Hit** — Compute `selfTime / hitCount` to normalize away call frequency and reveal intrinsic per-invocation cost
- **Recursive Call Detection** — Detect direct and indirect recursion in the call tree with depth and time reporting
- **Method Efficiency Score** — Compute `selfTime / totalTime` ratio to distinguish compute-bound methods from orchestrators
- **Hotspot-to-Source Deep Link** — Resolve each hotspot method to its source file location via tree-sitter-al, including file path and line range
- **Call Amplification Factor** — Compute `child.hitCount / parent.hitCount` on every edge to surface inner-loop fan-out

### Tier 2: High-Value Analysis

- **Critical Path Extraction** — Walk the call tree to find the single longest root-to-leaf path by totalTime
- **Variable Type Resolution** — Extract Record variable types from `var_section` declarations, mapping variable names to table references
- **Temporary Table Detection** — Detect `temporary` keyword on record variables and `SourceTableTemporary` on pages; exclude from N+1 warnings
- **"What If" Optimization Estimator** — Estimate time savings for each detected pattern (e.g., "fixing saves ~998ms")
- **Event Chain Tracer** — Trace full publisher → subscriber → transitive chains showing which events cause the most expensive cascades
- **Pattern-Level Comparison** — Extend profile comparison to include pattern differences: new, resolved, and severity-changed patterns
- **Profile Confidence Score** — 0–100 score based on sampling jitter, incomplete measurements, idle ratio, sample count, and duration
- **Commit/Error in Loop Detection** — Detect `Commit()`, `Error()`, and `TestField()` calls inside loops as severe anti-patterns
- **CalcField Complexity Scoring** — Parse `CalcFormula` from table declarations; graduate severity (SUM FlowField = critical, LOOKUP = warning)
- **Event Publisher/Subscriber Catalog** — Parse `[IntegrationEvent]`, `[BusinessEvent]`, and `[EventSubscriber]` attributes into a publisher→subscriber mapping
- **MCP Flamegraph Tool** — MCP tool that posts profile data to AL-Flamegraph API for interactive SVG visualization
- **Subtree Drill-Down** — Show a method's subtree time attribution breakdown (e.g., "60% SQL, 25% events, 15% own code")
- **Per-Instance Method Statistics** — Compute min/max/mean/median/p95/p99 of selfTime across multiple calls of the same method (instrumentation profiles)
- **Profile Health Score** — Single 0–100 score summarizing overall profile health from pattern counts, idle %, and timing distribution

### Tier 3: Strategic Investments

- **Field Reference Mapping** — Track which table fields are accessed per procedure via `field_access` and `field_ref` nodes; validate SetLoadFields coverage
- **Table Key Analysis** — Parse `key_declaration` from table declarations; cross-reference with SetRange/SetFilter to detect unindexed filter operations
- **Performance History Store** — JSON-based local store for tracking analysis results over time with CLI (`history list/trend/clear`) and MCP tools (`history_list`, `history_trend`)
- **Table-Centric View** — DBA-oriented analysis pivoting around database tables: per-table operation breakdown, call site counts, SetLoadFields/filter usage
- **Table Relationship Graph** — Parse `TableRelation`, `CalcFormula` references, and `lookup_where_conditions` to build a graph of table relationships

### Infrastructure

- **Section Registry** — Compile-time `SectionRenderers<T>` type ensures all formatters (terminal, markdown, HTML) render every section; TypeScript errors on missing sections
- **Formatter Parity** — Object breakdown, confidence/health scores, and pattern suggestions rendered consistently across all output formats and web UI
