Here is my independent expert review of your inventory, focusing strictly on technical accuracy, adversarial validation, and identifying blind spots in your coverage.

### A. Review of Claims

**1. In-app Performance Profiler = SAMPLING ONLY.**
**AGREE.** The source proves this directly. `U:/Git/BC.history/System Application/Source/System Application/Performance Profiler/src/dotnet.al` lines 10-13 wrap `Microsoft.Dynamics.Nav.Runtime.Debugger.SamplingProfiler` and generate a `CpuProfile`. `U:/Git/BC.history/System Application/Source/System Application/Performance Profiler/src/ProfilingNode.Table.al` explicitly relies on `Hit Count` (line 25), with `Self Time` and `Full Time` being derived. It is indeed a statistical V8 profile, meaning "cost" is inferred.

**2. Instrumentation profile (`.mdc` flatbuffer snapshot) carries NO SQL.**
**AGREE.** Snapshot debugging in BC instruments AL execution state (variable values, AL call stack frames) via the runtime. It does not hook the `NavSqlConnection` or SQL Command execution pipeline. Your empirical test of grepping 15,674 `.mdc` files perfectly corroborates the known platform architecture: snapshot debugging is strictly an AL-level state machine recording. 

**3. BCPT / Performance Toolkit = a MEASURED per-operation metric.**
**AGREE (with a technical caveat).** `U:/Git/BC.history/testframework/performancetoolkit/Performance Toolkit/src/BCPTLogEntry.Table.al` lines 61-64 define "No. of SQL Statements" and 49-52 define "Duration (ms)". However, note lines 112-115: Key 2 is explicitly designed *without* a SIFT index to avoid blocking inserts, while Key 3 (line 116) does apply SIFT to Duration. The BCPT framework itself introduces execution overhead; duration includes AL + SQL + BCPT overhead. But as a count/duration source, your claim holds.

**4. Table Information (System App) = per-table row counts / size.**
**AGREE.** This virtual table reads directly from the underlying SQL metadata (sys.partitions / sys.allocation_units) and caches the results. 

**5. RT0005 long-running-SQL telemetry = per slow statement... the ONLY place statement + rows-read + duration exist together.**
**DISAGREE.** It is the only *SaaS-accessible telemetry* place, but it is **not** the only place overall. For OnPrem, SQL Server **Extended Events (XEvents)** (`sqlserver.sql_statement_completed`) and **Query Store** absolutely capture exact statement text + logical/physical reads (rows) + exact measured duration (microseconds). Furthermore, RT0005 only captures statements exceeding a threshold (traditionally 1000ms, configurable OnPrem, fixed in SaaS). If a query takes 800ms and reads 500,000 rows, it will completely bypass RT0005. 

**6. Per-statement SQL text WITH rows-read is NOT AL-accessible.**
**AGREE.** The AL runtime sandbox intentionally walls off the underlying `SqlDataReader` metrics. AL can only observe what the `System.Tooling` module exposes.

---

### B. Missing Sources of Database-Operation Metrics

Your inventory severely underrepresents native database wait statistics, lock/deadlock telemetry, and OnPrem SQL tooling. Add these to your matrix immediately:

1. **Database Wait Statistics (AL Virtual Table `Database Wait Statistics`)**
   - **Delivers:** Wait category (e.g., `LCK_M_U`, `PAGEIOLATCH_SH`), wait count, and wait time (ms). 
   - **Granularity:** Aggregated at the instance/tenant level since server restart or tenant mount.
   - **Scope:** SaaS + OnPrem.
   - **Access:** Direct AL `Record "Database Wait Statistics"`. 
   - **Why it matters:** High SQL durations in BCPT or Profiles might be locking/waits, not bad query plans. This table proves *why* SQL is slow.

2. **Database Locks & Deadlocks Telemetry (App Insights RT0008, RT0016, RT0028)**
   - **Delivers:** The victim SQL statement, the blocking SQL statement, database name, and AL Stack Trace of the lock participants. 
   - **Granularity:** Per lock timeout or deadlock event.
   - **Scope:** SaaS + OnPrem.
   - **Why it matters:** A profile might show a query taking 5 seconds. RT0008 will tell you if 4.9 seconds of that was spent waiting on another session's uncommitted transaction. 

3. **OnPrem Extended Events (XEvents) & Query Store**
   - **Delivers:** Exact `sql_text`, `duration` (microseconds), `logical_reads`, `physical_reads`, `row_count`, and the actual Execution Plan XML.
   - **Granularity:** Per execution (100% capture possible, unlike RT0005).
   - **Scope:** **OnPrem Only**.
   - **Why it matters:** This is the absolute source of truth. If al-perf wants to analyze REAL database performance on-prem, parsing an XEvent `.xel` file or querying `sys.query_store_runtime_stats` yields the exact metrics RT0005 misses because of duration thresholds.

4. **Page View / Report Telemetry (App Insights RT0018 / RT0006)**
   - **Delivers:** Total `sqlExecutes` and `sqlRowsRead` aggregated per page load or report execution. 
   - **Granularity:** Per AL object execution (not per statement).
   - **Scope:** SaaS + OnPrem.
   - **Why it matters:** Corroborates the BCPT data without requiring a benchmark run. If RT0018 shows a Page opening with 5,000 SQL Executes, you immediately know there's a Partial Record / JIT load issue or an N+1 FlowField calculation problem.

### Top 3 Sources to Add to Inventory
1. **Extended Events / Query Store (OnPrem):** The only way to get statement + rows + duration for queries that fall *under* the RT0005 duration threshold.
2. **Database Wait Statistics (AL Virtual Table / RT0100):** Critical to disambiguate "slow SQL" from "blocked SQL".
3. **RT0008 / RT0016 Lock Telemetry:** Provides the exact SQL text of both the victim and the blocker.

```json evidence
{
  "files_checked": [
    "U:/Git/al-perf/docs/superpowers/research/2026-07-16-bc-sql-evidence-sources.md",
    "U:/Git/BC.history/System Application/Source/System Application/Performance Profiler/src/dotnet.al",
    "U:/Git/BC.history/System Application/Source/System Application/Performance Profiler/src/ProfilingNode.Table.al",
    "U:/Git/BC.history/testframework/performancetoolkit/Performance Toolkit/src/BCPTLogEntry.Table.al"
  ],
  "searches_performed": [],
  "confidence": "high"
}
```
