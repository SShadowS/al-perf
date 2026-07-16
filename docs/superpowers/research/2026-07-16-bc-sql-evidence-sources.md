# BC SQL/Perf Evidence Sources — Inventory (living doc)

**Date:** 2026-07-16
**Baseline:** Business Central **28+** (2026 wave 1). Do NOT use BC27 as baseline; the real captures here are BC 28.0.46665.
**Purpose:** Before finalizing the SQL evidence layer spec, catalogue EVERY source of SQL/performance evidence BC exposes — capture modes, endpoints, telemetry, and OnPrem system tables — and document what each actually delivers, grounded in real payloads, not guesses. A two-model panel (Gemini 3.1 Pro + GPT-5.6-sol) showed the first spec guessed at the data shape; this doc removes the guessing.

OnPrem-only sources count. Document them; we can ask Microsoft to bring them to SaaS scope later.

---

## Source matrix

| Source | Delivers SQL? | Granularity | Scope | Evidence status |
|---|---|---|---|---|
| **Sampling profile** (`.alcpuprofile`, `kind:1`) | **YES — rich** | per-statement SQL nodes, `hitCount` only (no duration) | SaaS + OnPrem | **PROVEN on real BC28 capture** |
| **Instrumentation profile** (`.alcpuprofile`, no `kind`) | **UNKNOWN** | exact per-call timing | SaaS + OnPrem | needs real BC28 capture (MS docs imply sampling-only) |
| **Snapshot debug** (`.snapshot`) | likely NO (state/replay, not SQL tree) | n/a | SaaS + OnPrem | needs confirmation of payload |
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

## What still needs a REAL capture (the gaps)

The capture path exists via **bc-dev-mcp** (`bcdev_profile_start { kind: "sampling" | "instrumentation" }` → `bcdev_profile_poll` → `bcdev_profile_finish` writes the `.alcpuprofile`; runs on the snapshot-debugger port 7083) driven against the **Cronus28** env via **bc-mcp**. Both MCP servers must be connected (`/mcp`) before a live capture.

**Experiment to settle the open questions** — drive ONE identical scenario (e.g. release a sales document, the profile-1 scenario) and capture it three ways, then diff payloads:

1. **Instrumentation `.alcpuprofile`** (`kind:"instrumentation"`) — does it carry SQL nodes, or is SQL sampling-only? MS docs imply sampling-only; **confirm on real BC28 data.** If instrumentation carries SQL WITH exact durations, that is strictly better than sampling for this layer.
2. **Debug `.snapshot`** — capture one and document what it actually contains (does it expose SQL statements/timing at all, or only replayable execution state?).
3. **The "SQL feature endpoint"** — what the BC28 SQL-in-profiles feature surfaces in VS Code beyond the raw node (does the client get rows-read / duration the wire node lacks?).

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
