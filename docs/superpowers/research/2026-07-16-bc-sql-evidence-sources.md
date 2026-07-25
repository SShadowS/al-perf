# BC SQL/Perf Evidence Sources — Inventory (living doc)

**Date:** 2026-07-16
**Baseline:** Business Central **28+** (2026 wave 1). Do NOT use BC27 as baseline; the real captures here are BC 28.0.46665.
**Purpose:** Before finalizing the SQL evidence layer spec, catalogue EVERY source of SQL/performance evidence BC exposes — capture modes, endpoints, telemetry, and OnPrem system tables — and document what each actually delivers, grounded in real payloads, not guesses. A two-model panel (Gemini 3.1 Pro + GPT-5.6-sol) showed the first spec guessed at the data shape; this doc removes the guessing.

OnPrem-only sources count. Document them; we can ask Microsoft to bring them to SaaS scope later.

**`Access = Internal` / permission-gated sources ALSO count.** Internal access is not disqualifying — catalogue what exists, then request Microsoft make it public (same play as OnPrem→SaaS). A table being Internal today just marks it as "request public access," not "unusable."

---

## ▶ RESUME HERE (next session — after bc-dev-mcp + bc-mcp are connected)

Paused pending live captures. When the MCP env is up, run ONE identical scenario (release a sales document — the profile-1 scenario) captured three ways, then diff payloads:

1. `bcdev_profile_status` — preflight the snapshot-debugger endpoint (port 7083).
2. **Sampling:** `bcdev_profile_start { kind: "sampling" }` → drive the scenario via bc-mcp (open Sales Order, release it) → `bcdev_profile_poll` until ready → `bcdev_profile_finish` → save `.alcpuprofile`.
3. **Instrumentation:** repeat with `bcdev_profile_start { kind: "instrumentation" }` on the SAME scenario. **Key question: does it carry SQL nodes, and with EXACT durations?** (Sampling has SQL but hitCount-only; if instrumentation has SQL + real time, it is strictly better for this layer.)
4. **Snapshot:** capture a debug `.snapshot` of the scenario; document whether it exposes SQL statements/timing at all or only replayable state.
5. Diff the three payloads: SQL-node presence, whether SQL nodes carry duration, table-name format, and whether `scriptId`/`applicationDefinition` self-identification holds across modes.

Then fold results into the matrix below and either revise the spec (annotate-only v1) or continue to the telemetry/OnPrem doc research.

**Still open, no env needed** (can do anytime): RT0005/RT0018/report/deadlock telemetry field inventory; OnPrem SQL Server DMVs / Query Store / BC system tables.

---

## Source matrix

| Source | Delivers SQL? | Granularity | Scope | Evidence status |
|---|---|---|---|---|
| **Sampling profile** (`.alcpuprofile`, `kind:1`) | **YES — rich** | per-statement SQL nodes, `hitCount` only (no duration) | SaaS + OnPrem | **PROVEN on real BC28 capture** |
| **Instrumentation** (`.mdc` flatbuffer zip → bc-mdc-converter) | **NO** | exact per-call AL execution (methods, variables, values, timing) — but NO SQL | SaaS + OnPrem | **DISPROVEN on real BC28 capture** (see below) |
| **Snapshot debug** (`.mdc` recording) | **NO** | same `.mdc` recording format as instrumentation | SaaS + OnPrem | same as instrumentation — no SQL |
| **`SessionInformation` AL counters** | count only — `SqlStatementsExecuted()` + `SqlRowsRead()` | session-cumulative; operation-level by before/after delta | SaaS + OnPrem, **in-AL** | **verified in BC source** (BCPT computes its count from this — `BCPTLine.Codeunit.al:134,153`) |
| **RT0005 long-running SQL telemetry** | `sqlStatement` + `executionTime` + `alStackTrace` — **no rows-read** | per slow statement, **threshold-gated (>~1000ms)** | SaaS + OnPrem (App Insights) | doc-confirmed; NOT the only statement+duration source (see panel-2) |
| **RT0009 SQL query trace** | YES — **all** `sqlStatement` (≤8192 ch) + `executionTime` | per statement incl. fast ones, while verbose logging on | SaaS + OnPrem (App Insights) | doc-cited (GPT); more complete than RT0005 |
| **RT0006 report / RT0008 web-service / RT0018 AL-method telemetry** | `sqlExecutes` + `sqlRowsRead` (NO statement text) | per object execution | SaaS + OnPrem | doc-cited |
| **RT0012/RT0013/RT0027 lock + RT0028 deadlock telemetry** | victim/lock SQL, table, mode, AL stack | per lock-timeout / deadlock event | SaaS + OnPrem | doc-cited; RT0012 `sqlStatement` field unverified |
| **Database Wait Statistics** (table + page; RT0025/RT0026) | NO SQL — wait category, wait/signal/max time, task count | aggregate per DB/category since restart | SaaS + OnPrem, in-app | **table verified** (`DatabaseWaitStatistics.page.al:14` `SourceTable`); external-ext read permission unverified |
| **AL debugger DB statistics** (`enableSQLInformationDebugger`) | YES — statement text + measured duration + approx rows + locks | per recent statement (default 10) + session totals | dev-time (SaaS sandbox / OnPrem) | doc-cited (GPT); not production |
| **OnPrem SQL Server: Extended Events / Query Store** | YES — exact text + reads + µs duration + plan | **per execution, 100%, threshold-free** | **OnPrem only** | doc-cited; strongest OnPrem source |
| **OnPrem SQL Server: DMVs** (`sys.dm_exec_query_stats` + `_sql_text`, index/wait DMVs) | YES — text, exec count, reads, elapsed/worker, rows returned | aggregate per cached plan / index | **OnPrem only** | doc-cited; `logical_reads`=pages, `total_rows`=rows *returned* ≠ BC `sqlRowsRead` |

---

## What the SAMPLING payload actually contains (PROVEN — real BC28 captures)

Source: `test/fixtures/batch-recorded/profile-1..4.alcpuprofile` — real Cronus Danmark A/S captures, `appVersion 28.0.46665`, `kind:1` (sampling). profile-1 = 488 nodes, **181 SQL nodes**. All four are sampling; all rich with SQL.

**SQL statements are call-tree nodes** whose `callFrame.functionName` IS the statement. Real examples (verbatim):

```
SELECT COUNT(*) FROM dbo."CRONUS Danmark A_S$Sales Header" WITH(READUNCOMMITTED) WHERE ("Document Type"=@0)
SELECT TOP (1) "Document Type","Document No_","Line No_",...(47 columns)... FROM dbo."CRONUS Danmark A_S$Sales Line" ...
UPDATE dbo."CRONUS Danmark A_S$Sales Header" SET "Status"=@0 OUTPUT inserted."timestamp" WHERE (...)
SELECT [Metadata],[User Code] FROM dbo.[Application Object Metadata] WHERE [Runtime Package ID]=@0 AND ...
```

These are literally the anti-pattern receipts: the 47-column `SELECT TOP(1)` is `missing-setloadfields`; the `SELECT COUNT(*)` is a Count-should-be-IsEmpty; the `UPDATE` is a Modify. **The core premise holds on real data.**

**Per-SQL-node facts (from the real capture):**
- Fields: `id, callFrame, hitCount, children, positionTicks, declaringApplication, applicationDefinition, frameIdentifier, isSynthetic`.
- **`hitCount` is the only count. There is NO duration/executionTime field on the node.** SQL time must be inferred from `hitCount × samplingInterval` (or sample-appearance counting — the processor already switches modes). So any "measuredCostUs"/"executionCount" is a **sampled estimate, not measured** — must be labelled as such. (Panel catch D — confirmed.)
- SQL nodes are **leaves** (`children:[]`); their parent is the node that lists them in `children`.
- **SQL nodes frequently SELF-IDENTIFY their issuing object** via `callFrame.scriptId` (`"CodeUnit_414"`, `"Page_1310"`) and `applicationDefinition` (`{objectType:5, objectName:"Release Sales Document", objectId:414}`). This is a MORE DIRECT correlation signal than the spec's tree-ancestry-only rule — but it is **not always populated** (some SQL nodes carry `applicationDefinition {objectType:0, objectName:"", objectId:-1}` while `scriptId` stays set). A correlation design should use scriptId/appDef when present and fall back to nearest-AL-ancestor otherwise.
- **`objectType` is numeric** in the raw wire (`1`=Table, `5`=CodeUnit, `8`=Page…), not a string.

**Table-name format (confirms panel catch E — real bug):**
- `dbo."<Company>$<Table>"` — e.g. `dbo."CRONUS Danmark A_S$Sales Header"`. The company here is `CRONUS Danmark A_S` (A/S → A_S).
- `dbo.[<System Table>]` — bracket-quoted, no company prefix (`dbo.[Application Object Metadata]`).
- Extension tables add a `$<AppGuid>` suffix (`<Company>$<Table>$<guid>`).
- The existing `extractTableName` (`src/explain/payloads/sql-patterns.ts:54`) strips at the **first** `$` → returns the **company name**, not the table, for every `Company$Table` case. **Broken for real BC physical names; must be rewritten before reuse.**

---

## Instrumentation & Snapshot — DISPROVEN (real BC28 capture, 2026-07-16)

Captured a live BC28 instrumentation profile via `bcdev_profile_start { kind: "instrumentation" }` against Cronus28 (drove a fresh WebClient session opening data pages: Customer List, Sales Orders, factboxes with FlowFields → the AL that, in sampling mode, issues SQL). Finish produced the raw flatbuffer zip `<ctx>.snapshot.zip` — **15,674 `.mdc` files** plus embedded AL source.

**Result: the instrumentation payload contains NO SQL.** Grepping all 15,674 `.mdc` files for the real DB-SQL signature that IS present in sampling captures (`dbo."`, `READUNCOMMITTED`, `FROM dbo.`) → **0 hits**. A strings dump shows only AL-level execution data: method names, variable names (`['Overdue Balance']`, `['LinkedVendorNo']`), values, types, timing. Same A/B against `profile-1.alcpuprofile` (sampling) → the markers ARE present.

So instrumentation records deterministic **AL execution** (every call, variables, values, exact counts) but **not the underlying SQL statements**. This is exactly why ir-json — which bc-mdc-converter derives from these `.mdc` files — has `Invocation.sql` always empty. The "snapshot" debug recording uses the same `.mdc` format and likewise carries no SQL.

**Conclusion, now settled: profile SQL is SAMPLING-ONLY.** The SQL evidence layer's profile-side ingest must target sampling `.alcpuprofile` captures; instrumentation and ir-json cannot supply SQL. Confirms the GPT-5.6-sol panel finding against real data.

## What BC's OWN source exposes to AL (`U:/Git/BC.history`, branch `w1-28` = BC28)

Verified against the decompiled BC28 AL source, not docs.

**Performance Profiler (System App) — SAMPLING ONLY, confirms everything.**
- `Performance Profiler/src/dotnet.al` wraps `Microsoft.Dynamics.Nav.Runtime.Debugger.**SamplingProfiler**` producing a **V8 `CpuProfile`/`CpuProfileNode`** — i.e. the `.alcpuprofile` is a V8 sampling profile. There is NO instrumentation profiler in the AL API. Source-side confirmation of sampling-only.
- No SQL toggle — the sampling profiler emits SQL nodes automatically (matches the real captures).
- `SamplingPerformanceProfiler.Codeunit.al` is the public API the al-perf-bc companion uses: `Start`/`Stop`/`GetData(): InStream` (the raw `.alcpuprofile` bytes) / `GetProfilingNodes` / `GetProfilingCallTree`.
- The canonical node model, table **"Profiling Node"** (`ProfilingNode.Table.al`): `Object Type`, `Object ID`, `Object Name`, **`Line No`** (field 9), `Method Name` Text[1024] (**where SQL statements ride**, truncated to 1024), `Self Time` (Duration), `Full Time` (Duration), `Hit Count`, `Indentation` (tree depth). Confirms from source: **Self Time is exclusive; Full Time inclusive; durations are derived from `Hit Count` × sampling interval (a sampled ESTIMATE, not per-statement measurement).** al-perf already parses the equivalent from the raw V8.
- `ScheduledPerfProfiler*` stores these `.alcpuprofile`s on a schedule — the source of the batch-recorded fixtures.

**BCPT / Performance Toolkit — a MEASURED, complementary SQL source.**
- `BCPTLogEntry.Table.al`: per named operation, field 12 **"No. of SQL Statements"** (Integer) + field 9 "Duration (ms)" (SIFT-indexed), plus Operation, Session No., Status, Error Call Stack. Measured per-operation SQL-statement COUNT + duration — SaaS + OnPrem, in-app. NOT the SQL text, NOT rows-read. **"Duration (ms)" is the operation's ELAPSED time (AL + SQL + BCPT overhead), not accumulated DB duration and not per-statement** (both panelists flagged this — don't call it "SQL duration"). The count is literally a `SessionInformation.SqlStatementsExecuted` delta (`BCPTLine.Codeunit.al:134,153`). Complements the sampling profile: profile = SQL *text* (estimated), BCPT = SQL *count* + *measured operation* duration. Requires running a benchmark suite. Table 149002 is **`Access = Internal`** (`BCPTLogEntry.Table.al:15`) — external extensions cannot read it directly TODAY, so either use its `AL0000DGF` App Insights telemetry, or **request Microsoft make the table public** (it exists and holds the data; Internal is a permission flag, not a technical wall).

**Table Information (System App)** — per-table row counts / size. Database **state**, not database **operation** (belongs in a capacity category, not the metric matrix). AL-accessible.

**AL-accessible SQL counters (corrects the earlier "NOT AL-accessible" claim).** `SessionInformation.SqlStatementsExecuted()` and `SessionInformation.SqlRowsRead()` ARE callable from AL and return session-cumulative counters; a before/after delta yields **operation-level SQL statement count + rows-read**, with no BCPT and no telemetry. Verified in BC source (BCPT itself uses it). What remains genuinely NOT AL-accessible is the *full per-statement tuple as one record* — statement text + its duration + its rows-read together. That still lives only in platform telemetry (RT0009 for text+duration; RT0006/RT0008/RT0018 for object-level rows-read) or, dev-time, the AL debugger's SQL statistics.

**Net for the spec:** the source confirms the profile-side SQL layer must ingest **sampling `.alcpuprofile`** (SQL in `Method Name`, cost a sampled estimate), and identifies **BCPT** as an optional measured corroboration source (SQL count + real duration per operation). Nothing here changes the annotate-only-v1 direction; it grounds it.

## What still needs a REAL capture (the gaps)

The capture path is proven working: **bc-dev-mcp** (`bcdev_profile_start { kind }` → `bcdev_profile_poll` → `bcdev_profile_finish`, snapshot-debugger port 7083) against **Cronus28**, driven by a fresh **bc-mcp** WebClient session. Sole-user container, so the "next session for user" arm always binds our session.

Remaining, lower-priority (SQL is settled as sampling-only):

1. **The "SQL feature endpoint"** — what the BC28 SQL-in-profiles feature surfaces in VS Code beyond the raw sampling node (does the client get rows-read / duration the wire node lacks?).
2. **Sampling live-capture ergonomics** — a live sampling `.alcpuprofile` is only extracted when `bcdev_profile_finish` is called while the session is STILL ALIVE and after samples accumulate; finishing after the session ends yields only the raw `.mdc` recording. (Not needed for the SQL question — the batch-recorded fixtures already provide real BC28 sampling SQL.)

---

## Panel-2: DB-operation metric sources (two-model review, 2026-07-16)

Second two-model panel (Gemini 3.1 Pro + GPT-5.6-sol), identical prompt, isolated — reviewed the 6 claims above and hunted for missed sources. `.panel/google-dbmetrics.md`, `.panel/openai-dbmetrics.md`, prompt `.panel/prompt-dbmetrics.txt`. Gemini: 4 files, 0 searches. GPT: 6 files, ~22 doc fetches (SerpAPI down; learn.microsoft.com/api + direct doc URLs succeeded). Corrections below are verified against BC source where a ✅ is shown.

**Claim corrections (consensus unless noted):**
- **Claim 5 was wrong.** RT0005 is NOT the only statement+rows+duration source, and does not even carry rows-read. Exact statement + reads + µs duration exist OnPrem in **Extended Events / Query Store** (100% capture, threshold-free — RT0005 fires only >~1000ms), and **RT0009** carries all statement text + duration incl. SaaS during verbose logging.
- **Claim 6 was too broad.** ✅ `SessionInformation.SqlStatementsExecuted()/SqlRowsRead()` are AL-native. Only the full per-statement *tuple* (text+duration+rows as one record) is not AL-accessible.
- **Claim 3 relabel.** BCPT "Duration (ms)" = operation elapsed, not SQL duration.
- **Claim 1 nuance** (GPT). System App does not compute Self Time as `hitCount × interval`; it is `Round(TimeDelta / 1000, 1)` from `CpuProfile.Samples` + `TimeDeltas` (`SamplingPerfProfilerImpl.Codeunit.al:161-168`). Still a sampled attribution, not a measured SQL duration — the estimate framing holds, the arithmetic does not.
- Claims 1 (core), 2, 4 confirmed by both.

**Source catalogue, tiered by access** (adopt GPT's doc-grounded RT taxonomy; drop Gemini's unsourced RT0016; all RT IDs are doc-derived, not capture-verified):

- **AL-native (in-app, no telemetry):**
  - ✅ `SessionInformation` counters — SQL statement count + rows-read, session-cumulative / operation-delta. No text, no per-table attribution. **Cheapest new evidence lane for a companion extension.**
  - ✅ Database Wait Statistics table (`SourceTable` proven; RT0025/RT0026 telemetry) — wait categories/times; disambiguates "slow SQL" from "blocked SQL." External-ext read permission unverified.
  - BCPT (measured count + operation duration; table Internal — use telemetry `AL0000DGF` today, or request table go public).
- **SaaS + OnPrem telemetry (App Insights):**
  - RT0009 — all SQL text + duration (verbose logging).
  - RT0005 — slow-statement text + duration + AL stack (>~1000ms; no rows-read).
  - RT0006 (report), RT0008 (web-service), RT0018 (long-running AL method) — `sqlExecutes` + `sqlRowsRead` at object granularity, no text.
  - RT0012/RT0013/RT0027 (lock timeout/snapshot), RT0028 (deadlock victim) — victim/lock SQL + AL stack.
- **Dev-time:** AL debugger DB statistics (`enableSQLInformationDebugger`) — statement text + measured duration + approx rows + locks; SaaS sandbox / OnPrem only.
- **OnPrem SQL Server (ask MS for SaaS later):** Extended Events (`sqlserver.sql_statement_completed`) + Query Store (survives plan-cache eviction) = the ground truth; DMVs (`sys.dm_exec_query_stats` + `_sql_text`, index-usage/operational/physical DMVs, in-flight `sys.dm_exec_requests`/`_os_waiting_tasks`/`_tran_locks`); Windows perf counters (service-instance SQL connection/cache aggregates); event-log long-running SQL (predecessor to RT0005, `SqlLongRunningThreshold`). Caveat: SQL Server `logical_reads`=pages, `total_rows`=rows *returned* — do not map directly to BC `sqlRowsRead`.
- **Correctly excluded** (both/GPT): Session Event table (no SQL metrics); `$ndo$…`/`NavApp$…`/`BC$…` physical tables (data/metadata, not metric stores — useful only to map physical names to BC objects).

**Both panelists' top-3 additions converged:** (1) OnPrem Extended Events + Query Store, (2) Database Wait Statistics, (3) all-SQL trace (GPT: RT0009) / lock telemetry (Gemini: RT0008/RT0012).

## Gated/virtual metric tables — field inventory + why-public case

You CAN see what's in the gated tables (two routes), so the "request public access" ask can be specific and evidenced, not blind.

**Route 1 — gated table with open-source definition (read the `.Table.al` directly).**

`BCPT Log Entry` (149002, `Access = Internal`, `BCPTLogEntry.Table.al`) — per operation:
`Duration (ms)` (Integer, SIFT), `No. of SQL Statements` (Integer), `Start Time`/`End Time`, `Operation`, `Codeunit ID`/`Name`, `Status`, `Error Call Stack` (2048), `Version`, `RunID` (Guid), `Session No.`, `Tag`.
`BCPT Line` (`BCPTLine.Table.al`) adds version-compare aggregate FlowFields: `No. of Iterations`, `Total Duration (ms)`, `No. of SQL Statements` — each with a `- Base` twin (`:143-239`) computing **SQL-count + duration deltas between two code versions**. A ready-made regression dataset.

**Route 2 — platform virtual table (no def in repo): the page over it enumerates fields + tooltips + names the backing DMV.**

`Database Wait Statistics` (page 9520 over virtual table `"Database Wait Statistics"`, `DatabaseWaitStatistics.page.al`):
`Wait Category`, `Waiting Tasks Count`, `Wait Time in ms` (incl. signal), `Max Wait Time in ms`, `Signal Wait Time in ms`, `Database start time` — aggregate since DB start. Page instructional text names the backing DMVs: `sys.query_store_wait_stats` / `sys.dm_db_wait_stats` (Azure SQL) / `sys.dm_os_wait_stats`. Emit codeunit 9521 (Internal) → `NavSqlConnectionTelemetry.SendWaitStatisticsSnapshotToTelemetry()` (RT0025/RT0026).

**Precedent that the ask is reasonable:** `Table Information` (page 8700 over virtual table `"Table Information"`) is the SAME class of virtual table but is **already publicly readable** — `Permissions = tabledata "Table Information" = r` (`No. of Records`, `Record Size`, `Size/Data/Index (KB)`, `Compression`). A virtual DB-metrics table CAN be public-read; Wait Statistics simply hasn't been granted it.

**Why-public justification per source (for the MS request):**
- **BCPT Log Entry / Line** — the ONLY in-app measured SQL-count + duration per operation, with built-in version-over-version deltas. Table is `Access = Internal`. **UPDATE (sweep): no MS ask needed** — retrievable today via the official BCPT REST API (pages 149006/7/8, permission set 149000 Public/Assignable grants `BCPT Log Entry = RIMD`); install the Performance Toolkit app + assign the set. Telemetry scraping (`AL0000DGF`) is the fallback. Only the `- Base` regression-delta FlowFields still require in-app access.
- **Database Wait Statistics table** — answers "is slow SQL actually blocked SQL?", the single biggest false-positive risk when attributing profile cost. **UPDATE (sweep): the ask is even smaller than thought** — sibling virtual tables `Database Locks` (via `LOGIN`) and `Database Index` (via the Table Information page grant) are confirmed *public-readable*; Wait Statistics is the same family and almost certainly grantable the same way. And `Database Locks` is the stronger source: it gives per-lock AL-object attribution the DB-wide Wait Statistics aggregate can't.
- **General principle** — Internal ≠ unusable. Every gated source here has a fully-known field set (open-source def or page-surfaced). Catalogue now, request `Access = Public` read-only per table with the field list + use case attached.

## Enrichment opportunity map (2026-07-16 three-investigator sweep)

Reinvestigation of "what could improve al-perf," grouped by access. Sources are net-new or upgraded vs the catalogue above. All findings cite the discovering source; verify file:line before building.

### Bucket 1 — already ingested by al-perf, currently discarded (zero new capture)

| # | Datum (file) | Used today | What it unlocks | Effort |
|---|---|---|---|---|
| **1** | **Batch manifest measured SQL/HTTP** — `sqlCallCount`, `sqlCallDuration`, `httpCallCount/Duration`, `alExecutionDuration`, `activityDuration` (`src/types/batch.ts`; real: `manifest.json` `sqlCallCount:1381, sqlCallDuration:382`) | display-only (`batch-html.ts:125`); no detector, not in terminal/markdown | **MEASURED per-activity SQL count+duration already in-tool** — cross-check the profile's sampled estimate; SQL-bound vs AL-bound flag; `activityDuration − alExec − sql − http` = unaccounted client/render time | **trivial** |
| 2 | RT0005 not fully extracted (`src/lifecycle/appinsights.ts:33,188`) — pulled by default but KQL never adds `customDimensions.sqlStatement`; full `alStackTrace` fetched, only first line kept | partial | actual slow-SQL text + full AL stack from a query al-perf already runs | moderate |
| 3 | Sampling per-node `lineNumber` (verified 270/283 nodes; `processor.ts:111` drops it) | no (only instrumentation `positionTicks`) | line-level hotspots on the ONLY format that carries SQL | moderate |
| 4 | `irCapture.exceptionCount`/`invocationCount` (`analyzer.ts:373` copies only `incompleteCount`) | no | error-storm confidence/anomaly factor | trivial |
| 5 | ir-json `exception`/`lines`(hit counts)/`callerLine` (`irjson-parser.ts:45` drops) | no | which invocation threw + where; loop-iteration counts; precise call-site | moderate |
| 6 | `instanceStats` p95/p99/stdDev + `callAmplification` (`aggregator.ts:196`) | no (in raw json only) | tail-latency / lock-contention signature detector | moderate |
| 7 | SQL-node `applicationDefinition`/`declaringApplication` unused even in `--deep` (`sql-patterns.ts:62`) | no | which AL object/app issued each SQL pattern | moderate |
| 8 | `TableKeyInfo.clustered` parsed (`indexer.ts:1155`), read nowhere | no | sargability: is `SetCurrentKey` hitting clustered key? | small |

### Bucket 2 — OnPrem direct SQL (document; request SaaS equivalent later)

**Build Query Store first.** Threshold-free (every statement, not just >750/1000ms), survives plan-cache eviction + BC restarts, low permission ask (`VIEW DATABASE STATE` on one DB), MS-recommended for BC. Views: `sys.query_store_query`/`_query_text`/`_plan`/`_runtime_stats`/`_runtime_stats_interval`/`_wait_stats` → text + `count_executions` + duration/CPU (µs) + logical/physical reads (pages) + rowcount + wait category, per query/plan/interval. All plain T-SQL — reachable from Bun via `mssql`/`tedious`, no .NET.

Follow-ons: **Extended Events** (`sqlserver.rpc_completed` + `sql_batch_completed`; read `.xel` server-side via `sys.fn_xe_file_target_read_file` — no .NET; MI target is blob not disk) for targeted per-execution deep captures. **DMVs**: `dm_exec_query_stats` + `CROSS APPLY dm_exec_sql_text`/`dm_exec_query_plan`; index usage/operational/missing triad; in-flight `dm_exec_requests`/`dm_os_waiting_tasks`/`dm_tran_locks`. **BC Server perf counters** (perfmon/WMI, not SQL perms) — incl. **CalcFields cache hit-rate** (corroborates `calcfields-in-loop`), command/result-set cache, query-repositioning rate, connection counts, heartbeat ms.

Gotchas: `logical_reads`=8KB pages not rows; `rows`=returned not examined; DMV plan-cache stats vanish on eviction (Query Store doesn't).

**Correlation (no shared id exists):** time-window overlap + database match + `query_hash`/normalized-text. RT0005's `sqlServerSessionId` is the closest cross-system key (join to `dm_exec_sessions`/`dm_tran_locks`). **Physical→logical mapping:** split on EVERY `$` (`parts[1]`=table, `parts[2]`=extension GUID); no SQL-side object-metadata table in BC28 (retired at BC16) → resolve against al-perf's tree-sitter `SourceIndex`; 128-char identifier overflow is unparseable-fallback.

### Bucket 3 — "if Microsoft approves" (mostly already open)

**Already public — NO approval needed (permission chain traced in BC source):**
- **Database Locks** (page 9511 / virtual table `"Database Locks"`) — live lock snapshot **with AL object type/id/name + method scope + extension name** per lock. Granted via `Session-Read` (permset 95) → `System Tables-Basic` (66) → `System Application-Basic` (69) → **`LOGIN` (161, Public/Assignable)** — every signed-in user. Answers "slow SQL vs *blocked* SQL, by which extension" — Wait Statistics (DB-wide aggregate) can't. **Best new source.** Wait-stats telemetry fires once/day → read the table directly for fresh data.
- **Database Index** (table, backs page 8700) — per-index fragmentation % + seek/scan/lookup/update counts + last-use timestamps + size. Public: Table Information page grants `tabledata "Database Index" = r` (`TableInformation.Page.al:30-32` — a grant this doc previously missed). Pairs with `Index Management` NST codeunit (toggle indexes).
- **BCPT via REST** — official OData v1.0 API pages 149006/149007/**149008** (`BCPTLogEntryAPI.Page.al`, `target: Cloud`); permission set **149000 "BC Perf. Toolkit" (Public, Assignable)** grants `tabledata "BCPT Log Entry" = RIMD`. Install the (MIT, first-party) Performance Toolkit app + assign the set → measured duration + `numberOfSQLStmts` over REST **today**. Upgrades the "Internal, scrape `AL0000DGF`" framing. Caveat: the `- Base` version-delta FlowFields are NOT in the API layout.

**Still gated / needs the request-public treatment:**
- **Database Missing Indexes** (page 9521 / `sys.dm_db_missing_index_details`) — `Index Equality/Inequality/Include Columns`, seeks/scans, `Average Impact`, **`Estimated Benefit`** (default-sorted desc). No permission set grants it anywhere — request public read.
- **Table Information Cache** (table 8700, `Access = Internal`, `DataPerCompany=false`) — `Growth %` (30-day), `Last Period Data Size/Records`. Table-growth trend.
- **Performance Profile Scheduler** (page 1932 / virtual table, permsets 1922/1923 Internal) — `Activity Duration Threshold (ms)` (default 500) + `Frequency` (Sampling Interval 50/100/150ms, default 100) + `Activity` filter (Web Client/Background/Web API). Controls how aggressively the platform auto-captures the sampling profiles al-perf consumes.

**Dead ends from source (need the NST assembly, not AL):** `NavSqlConnectionTelemetry` has one AL call site (`SendWaitStatisticsSnapshotToTelemetry`); .NET internals invisible without `Microsoft.Dynamics.Nav.Ncl.dll`. ~170 `Microsoft.Dynamics.Nav.*` types swept → **no sibling instrumentation/SQL-profiler .NET type exists** (declaration-side confirmation of sampling-only). Two distinct dev-time VS Code flags found: `enableSqlInformationDebugger` AND `enableLongRunningSqlStatements`. No AL-settable `SqlLongRunningThreshold` (server config only, `Set-NAVServerConfiguration`, default 1000ms; platform telemetry default 750ms).

## Pending doc research (mostly answered by panel-2; remaining)

- Exact `customDimensions` field lists per RT signal (names + types) for the project-2 telemetry-SQL spec — panel gave the taxonomy; still want a field-level table per event ID before building.
- Whether an external extension actually gets **read permission** on the `Database Wait Statistics` virtual table (page proves the type exists; permission scope unconfirmed).
- `$ndo$dbproperty` and any service-tier SQL-stat tables written on-prem — low priority (metrics come from DMVs/Query Store/XE, not these).

---

## Implications for the spec (already banked from the panel + real data)

- SQL cost is a **sampled estimate**, never measured — provenance must be explicit (`countKind`/`timeKind`), no "runtime-confirmed" / "exact" claims in v1.
- ir-json carries **no** SQL (`Invocation.sql` always empty — bc-mdc-converter spec) → drop the ir-json "exact" tier entirely.
- `analyzeProfile` does **not** run source-only detectors → the "give impact:0 source-only findings a rank" motivation is mostly moot in the profile path; rescope.
- Do **not** overwrite `impact` (selfTime excludes children; SQL is a child) → separate rank signal.
- Rewrite table-name parsing for `Company$Table$guid` + `[System Table]` before reuse.
- Use SQL-node `scriptId`/`applicationDefinition` self-identification as the primary correlation key; nearest-AL-ancestor as fallback.
- Rows-read is NOT profiler-side. If v1 wants a rows-read signal, the AL-native path is a companion extension reading `SessionInformation.SqlRowsRead()` deltas (operation-level, not per-statement) — separate from the profile ingest. Full per-statement text+rows+duration is telemetry/OnPrem-only.
- Telemetry-side (project 2) target set is broader than RT0005: RT0009 (all SQL text+duration), RT0006/RT0008/RT0018 (object-level rows-read), RT0012/13/27/28 (locks/deadlock). RT0005 alone is threshold-gated and rows-read-less.

---

## ✅ GATE 0 ANSWERED (2026-07-25) — live BC telemetry, ISV production App Insights

Probe run via `az monitor app-insights query` against a real resource, 7-day window:
RT0005 15,987 rows / 841 distinct stacks; RT0018 17,073 rows / 1,381 distinct stacks.
Redacted probe output committed at `test/fixtures/telemetry/rt0005-probe.json`.

| Question | Answer |
|---|---|
| RT0005 carries `alMethod`? | **No.** Absent from the dimension set. RT0018 has it. Confirms the routine join must parse `alStackTrace`. |
| `sqlStatement` on RT0005? | **Yes.** Sampled lengths 890–6,483 chars (8,192 truncation is real but not the common case). |
| `alStackTrace` grammar | **Header lines, then the first frame INLINE:** `AppObjectType: <T>\r\n  AppObjectId: <N>\r\n  AL CallStack: "<Object Name>"(<Type> <Id>).<Method> line <N> - <app> by <publisher> version <v>`, further frames one per line. `OnRun(Trigger)` appears as a method name. **Line 0 is the header** — the shipped `stackTrace.split(/\r?\n/)[0]` fallback yields `AppObjectType: Table`, confirming the identity bug on live data. |
| `executionTimeInMs` exists? | **Effectively NO — and the shipped puller depends on it.** Non-null on **0 of 17,045** RT0018 rows and **6 of 15,957** RT0005 rows. `src/lifecycle/appinsights.ts` reads exactly this column, so `max(ms)` is null and `asDurationMs` throws: `lifecycle pull-telemetry` cannot have worked against this telemetry. **Working path:** `toreal(totimespan(customDimensions.executionTime))/10000` → non-null on **100%** of rows for both signals (Microsoft's own documented conversion). |
| `longRunningThreshold` per row? | **Yes, as a .NET timespan**, non-null on 100% of rows. RT0005 uniformly **750 ms**, RT0018 uniformly **1000 ms**. `longRunningThresholdInMs` is as absent as `executionTimeInMs` (6 rows). |
| RT0018 `sqlExecutes` / `sqlRowsRead`? | **Both present** — these tenants are BC ≥ v22.0. |
| Stack fragmentation for §10's regrouping | **Safe.** RT0005 ≈19 rows per distinct stack, RT0018 ≈12. Regrouping on `alStackTrace` splits findings by routine, not into per-row dust. |

**Statement shape note (changes the redactor's corpus):** real statements alias-qualify their
columns — `"Purch_ Rcpt_ Line"."timestamp"`, `"99001472"."Store No_"` — and the company-prefixed
physical name appears in the `FROM` clause rather than in the projection. The redaction corpus must
cover alias-qualified column references, not only `dbo."Company$Table"` forms.

**Verdict: GO**, with one prerequisite — the duration extraction is broken in shipped code and must
be fixed as part of this work, for BOTH signals, before any pull produces usable data.
