# BC SQL/Perf Evidence Sources — Inventory (living doc)

**Date:** 2026-07-16
**Baseline:** Business Central **28+** (2026 wave 1). Do NOT use BC27 as baseline; the real captures here are BC 28.0.46665.
**Purpose:** Before finalizing the SQL evidence layer spec, catalogue EVERY source of SQL/performance evidence BC exposes — capture modes, endpoints, telemetry, and OnPrem system tables — and document what each actually delivers, grounded in real payloads, not guesses. A two-model panel (Gemini 3.1 Pro + GPT-5.6-sol) showed the first spec guessed at the data shape; this doc removes the guessing.

OnPrem-only sources count. Document them; we can ask Microsoft to bring them to SaaS scope later.

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
| **RT0005 long-running SQL telemetry** | YES — `sqlStatement` + `executionTime` + `alStackTrace` | per slow statement | SaaS + OnPrem (App Insights) | doc-confirmed; al-perf drops it today (separate project 2) |
| **RT0018 / report / deadlock telemetry** | partial (`sqlExecutes`, `sqlRowsRead`, victim SQL) | per event | SaaS + OnPrem | doc research pending |
| **OnPrem SQL Server DMVs / Query Store** | YES — plans, rows, waits | per query/plan | **OnPrem only** | doc research pending |
| **OnPrem BC system tables** (`$ndo$…`, session/telemetry) | partial | varies | **OnPrem only** | doc research pending |

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

## What still needs a REAL capture (the gaps)

The capture path is proven working: **bc-dev-mcp** (`bcdev_profile_start { kind }` → `bcdev_profile_poll` → `bcdev_profile_finish`, snapshot-debugger port 7083) against **Cronus28**, driven by a fresh **bc-mcp** WebClient session. Sole-user container, so the "next session for user" arm always binds our session.

Remaining, lower-priority (SQL is settled as sampling-only):

1. **The "SQL feature endpoint"** — what the BC28 SQL-in-profiles feature surfaces in VS Code beyond the raw sampling node (does the client get rows-read / duration the wire node lacks?).
2. **Sampling live-capture ergonomics** — a live sampling `.alcpuprofile` is only extracted when `bcdev_profile_finish` is called while the session is STILL ALIVE and after samples accumulate; finishing after the session ends yields only the raw `.mdc` recording. (Not needed for the SQL question — the batch-recorded fixtures already provide real BC28 sampling SQL.)

---

## Pending doc research (no live env needed)

- **RT0005 / RT0018 / report / deadlock telemetry** — exact `customDimensions` fields per signal (`sqlStatement`, `executionTime`, `alStackTrace`, `sqlExecutes`, `sqlRowsRead`, `numberOfRows`, `readUncommitted`, …), granularity, and SaaS-vs-OnPrem availability. (Feeds project-2 telemetry-SQL spec.)
- **OnPrem SQL Server** — DMVs (`sys.dm_exec_query_stats`, `sys.dm_exec_sql_text`, query plans), Query Store, and Extended Events for BC — what plans/rows/waits are obtainable that SaaS cannot give.
- **OnPrem BC system tables** — `$ndo$dbproperty`, session/telemetry tables, and any SQL-stat tables the service tier writes on-prem.

---

## Implications for the spec (already banked from the panel + real data)

- SQL cost is a **sampled estimate**, never measured — provenance must be explicit (`countKind`/`timeKind`), no "runtime-confirmed" / "exact" claims in v1.
- ir-json carries **no** SQL (`Invocation.sql` always empty — bc-mdc-converter spec) → drop the ir-json "exact" tier entirely.
- `analyzeProfile` does **not** run source-only detectors → the "give impact:0 source-only findings a rank" motivation is mostly moot in the profile path; rescope.
- Do **not** overwrite `impact` (selfTime excludes children; SQL is a child) → separate rank signal.
- Rewrite table-name parsing for `Company$Table$guid` + `[System Table]` before reuse.
- Use SQL-node `scriptId`/`applicationDefinition` self-identification as the primary correlation key; nearest-AL-ancestor as fallback.
