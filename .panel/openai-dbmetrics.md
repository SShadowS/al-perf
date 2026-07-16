## A. Claim-by-claim review

### 1. In-app Performance Profiler = sampling only

**DISAGREE as written; core conclusion is correct. Confidence: high.**

Correct:

- The public in-app API is explicitly `"Sampling Performance Profiler"` and exposes only sampling-oriented `Start`, `Stop`, `GetData`, and node/call-tree methods:  
  `U:/Git/BC.history/System Application/Source/System Application/Performance Profiler/src/SamplingPerformanceProfiler.Codeunit.al:8-89`.
- Its .NET interop uses `SamplingProfiler`, `CpuProfile`, and `CpuProfileNode`:  
  `U:/Git/BC.history/System Application/Source/System Application/Performance Profiler/src/dotnet.al:8-27`.
- Imported profiles are rejected unless `CpuProfile.Kind = Sampling`:  
  `U:/Git/BC.history/System Application/Source/System Application/Performance Profiler/src/SamplingPerfProfilerImpl.Codeunit.al:89-100`.
- `CpuProfileNode.CallFrame.FunctionName` is copied into `"Method Name"` and `HitCount` into `"Hit Count"`:  
  `SamplingPerfProfilerImpl.Codeunit.al:131-159`.
- Microsoft now explicitly documents that the **in-client profiler automatically uses sampling**, and that SQL tracking requires sampling:  
  https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-al-profiler-overview

The error is the exact timing formula. The System App does **not** compute `Self Time` from `Hit Count × configured sampling interval`. It associates `CpuProfile.Samples` with `CpuProfile.TimeDeltas` and converts the time delta to a duration:

- `GetProfilingNodes` consumes `Samples` and `TimeDeltas`:  
  `SamplingPerfProfilerImpl.Codeunit.al:113-129`.
- `Self Time := Round(TimeDelta / 1000, 1)`:  
  `SamplingPerfProfilerImpl.Codeunit.al:161-168`.
- Call-tree `Full Time` is `Self Time + children Full Time`:  
  `SamplingPerfProfilerImpl.Codeunit.al:242-270`.

Thus the defensible wording is:

> SQL time is derived from profiler sampling/time-delta data and is a sampled attribution, not a measured SQL execution duration. `hitCount × nominal interval` may be an approximation but is not the canonical System App calculation.

I did not independently inspect the raw capture proving every SQL node is a child of its issuing AL frame; I only read that assertion in the inventory.

---

### 2. Instrumentation `.mdc` carries no SQL

**AGREE, with evidentiary qualification. Confidence: medium-high.**

Microsoft's profiler documentation separates:

- instrumentation: exact method timing and call counts;
- sampling: the mode that surfaces SQL calls.

The BC28 source also rejects non-sampling `CpuProfile` data in the in-app path. See the AL Profiler overview above and `SamplingPerfProfilerImpl.Codeunit.al:89-100`.

However, I did **not** inspect the 15,674 `.mdc` files or the converter implementation. Therefore:

- I accept the real-capture result as reported.
- I cannot independently certify the exact “zero markers” count.
- I cannot independently certify that `Invocation.sql` is always empty for every converter/version.

The inventory should say “no SQL observed in the tested BC28 instrumentation capture; consistent with Microsoft's documented sampling-only SQL support,” rather than treating a string grep as a format-level proof for all future versions.

---

### 3. BCPT supplies measured count and duration

**AGREE, but label the duration correctly. Confidence: high.**

The table contains:

- `"Duration (ms)"`:  
  `U:/Git/BC.history/testframework/performancetoolkit/Performance Toolkit/src/BCPTLogEntry.Table.al:52-55`
- `"No. of SQL Statements"`:  
  `BCPTLogEntry.Table.al:68-71`
- a duration SumIndexField:  
  `BCPTLogEntry.Table.al:136-139`

Important qualification: `"Duration (ms)"` is the **elapsed duration of the BCPT operation/scenario**, not accumulated database duration and not a per-SQL-statement duration. Calling it a “real SQL duration” would be wrong.

BCPT also emits Application Insights telemetry. Event `AL0000DGF` includes `operation`, `noOfSqlStatements`, `startTime`, `endTime`, and `durationInMs`:

https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-performance-toolkit-trace

That telemetry transport is missing from the inventory even though the underlying metric is already listed.

---

### 4. Table Information supplies table row counts and sizes

**AGREE. Confidence: high.**

Page 8700 provides per company/table:

- record count;
- average record size;
- data size;
- index size;
- total used size;
- compression;
- index-management access.

It excludes indexed-view/SIFT sizes and shows used rather than allocated space:

https://learn.microsoft.com/en-us/dynamics365/business-central/admin-view-table-information

This is database-state information, not database-**operation** telemetry, so it should be placed in a separate “capacity/table statistics” category.

---

### 5. RT0005 has statement + rows-read + duration and is the only such source

**DISAGREE. Confidence: almost certain.**

The current Microsoft RT0005 schema lists:

- `sqlStatement`
- `executionTime`
- `alStackTrace`
- object/session dimensions

It does **not** list `sqlRowsRead`:

https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-long-running-sql-query-trace

`sqlExecutes` and `sqlRowsRead` belong to other, operation-level signals. For example, report telemetry RT0006 has:

- report-level `sqlExecutes`;
- report-level `sqlRowsRead`;
- `serverExecutionTime` and `totalTime`;
- no individual SQL statement text.

https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-reports-trace

Also:

- **RT0009** supplies every captured statement's text and execution duration when verbose logging is enabled, although not rows read:  
  https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-sql-query-trace
- The **AL debugger SQL statement statistics** supplies statement text, measured duration, and approximate rows read together:  
  https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-debugging

Therefore the inventory's “only place” assertion is doubly wrong:

1. RT0005 does not document rows read.
2. The debugger exposes the complete tuple, albeit as development tooling rather than Application Insights.

---

### 6. Per-statement SQL text with rows read is not AL-accessible

**DISAGREE as written; a narrower claim would be correct. Confidence: high.**

A precise version would be:

> No documented callable AL API returns per-statement SQL text, per-statement duration, and per-statement rows read as one record.

But the rest of the claim is false:

- `SessionInformation.SqlStatementsExecuted()` and `SessionInformation.SqlRowsRead()` are callable from AL and return session-cumulative counters:  
  https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/methods-auto/sessioninformation/sessioninformation-data-type
- Taking before/after values gives operation-level SQL statement and rows-read deltas without BCPT.
- The AL debugger exposes recent statement text, duration, approximate rows read, and locks held:  
  https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-debugging
- RT0005 does not document rows read, so the full tuple does not “live only in RT0005.”

The `Database` data type does **not** add SQL metric getters. It provides transaction, lock-timeout, connection, identity, and row-version operations:

https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/methods-auto/database/database-data-type

---

## B. Missing sources

### 1. AL debugger database statistics

**What it delivers**

Per recent SQL statement:

- statement text;
- execution timestamp;
- measured duration in milliseconds;
- approximate rows read.

Also:

- session totals for SQL executes and rows read;
- SQL latency;
- locks currently held, including lock access mode;
- recent statements and recent long-running statements.

**Granularity:** per recent statement plus session aggregates. Default history is 10 statements.

**Scope:** OnPrem and environments where AL debugging is permitted; practically SaaS sandboxes/development, not ordinary SaaS production profiling.

**Access:** set `enableSQLInformationDebugger`, attach the VS Code AL debugger, then expand `<Database statistics>`.

**Evidence:**  
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-debugging

This is not an “AL Profiler SQL-call-info” feature; it is an **AL debugger database-statistics** feature. It is the strongest omission.

---

### 2. RT0009 SQL query trace

**What it delivers**

For every SQL query while verbose/additional logging is active:

- `sqlStatement` up to 8192 characters;
- `executionTime`;
- AL object identity;
- SQL Server session ID;
- company/session context.

It does not document per-statement rows read or AL stack trace.

**Granularity:** per executed SQL statement, including fast statements.

**Scope:** BC28 SaaS and OnPrem telemetry.

**Access:** enable additional/verbose logging from Help & Support or the admin center; query `traces` where `eventId == "RT0009"`.

**Evidence:**  
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-sql-query-trace

Waldo accurately describes this as a temporary SaaS SQL profiler:

https://waldo.be/2026/02/24/troubleshooting-series-ep5-telemetry/

---

### 3. `SessionInformation` AL counters

**What it delivers**

- total SQL statements executed since session start;
- total SQL rows read since session start.

Read before and after a target operation to obtain exact operation deltas:

```al
BeforeExecutes := SessionInformation.SqlStatementsExecuted();
BeforeRows := SessionInformation.SqlRowsRead();

// operation

OperationExecutes := SessionInformation.SqlStatementsExecuted() - BeforeExecutes;
OperationRows := SessionInformation.SqlRowsRead() - BeforeRows;
```

**Granularity:** session-cumulative natively; arbitrary operation-level by delta. No text, timing, or table attribution.

**Scope:** SaaS and OnPrem.

**Access:** directly from AL.

**Evidence:**  
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/methods-auto/sessioninformation/sessioninformation-data-type

This directly expands the proposed companion extension beyond BCPT.

---

### 4. RT0018 long-running AL method telemetry

**What it delivers**

- AL object/method and stack;
- `executionTime` and `exclusiveTime`;
- `sqlExecutes`;
- `sqlRowsRead`;
- per-extension subscriber execution count/time.

**Granularity:** one long-running AL method event, not one SQL statement.

**Scope:** SaaS and OnPrem; OnPrem requires AL Function Timing/Logging configuration. SaaS emission is threshold/service controlled.

**Access:** Application Insights `traces`, `eventId == "RT0018"`.

**Evidence:**  
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-al-method-trace

---

### 5. RT0006 report telemetry

**What it delivers**

Per report execution:

- SQL statement count;
- SQL rows read;
- dataset rows;
- server execution time;
- total/render time;
- report, layout, action, stack, result, and database access intent.

No individual SQL text.

**Granularity:** report invocation.

**Scope:** SaaS and OnPrem.

**Access:** Application Insights `traces`, `eventId == "RT0006"`.

**Evidence:**  
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-reports-trace

---

### 6. RT0008 incoming web-service telemetry

**What it delivers**

Per API/OData/SOAP request:

- endpoint and query filter;
- SQL executes and SQL rows read;
- queue, server, and total time;
- object identity;
- status/failure dimensions.

No individual SQL text.

**Granularity:** web-service request.

**Scope:** SaaS and OnPrem.

**Access:** Application Insights `traces`, `eventId == "RT0008"`.

**Evidence:**  
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-webservices-trace

API query objects and pages exposed as services will appear here; I found no separate documented “query object SQL metrics” event.

---

### 7. Lock timeout and lock snapshot telemetry

**RT0012 — timeout victim**

- requesting AL object and stack;
- BC and SQL session IDs;
- snapshot correlation ID.

**RT0013 — lock snapshot entry**

- locked table;
- resource type;
- lock mode and status;
- holding/requesting object, session, and stack context.

**RT0027 — manually requested snapshot parent**

- groups RT0013 entries by `snapshotId`.

**Granularity:** timeout and individual lock entries.

**Scope:** SaaS and OnPrem; OnPrem requires `EnableLockTimeoutMonitoring`.

**Access:** Application Insights and KQL joins on `snapshotId`.

**Evidence:**  
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-database-locks-trace

Note that the RT0012 sample KQL projects `sqlStatement`, but the documented RT0012 dimension table does not define it. Do not rely on that field without a real BC28 capture.

---

### 8. RT0028 deadlock telemetry

**What it delivers**

For the deadlock victim:

- victim SQL statement;
- AL object and stack;
- BC and SQL session IDs;
- company/extension context.

It does not deliver the complete SQL Server deadlock graph or all participants.

**Granularity:** deadlock victim event.

**Scope:** SaaS and OnPrem; OnPrem requires `EnableDeadlockMonitoring`.

**Access:** Application Insights `eventId == "RT0028"`.

**Evidence:**  
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-database-deadlocks-trace

---

### 9. Database Wait Statistics and RT0025/RT0026

**What it delivers**

Cumulative, database-wide wait categories:

- total wait time;
- maximum wait time;
- signal wait time;
- waiting-task count;
- database start time;
- categories such as CPU, lock, buffer I/O, and idle.

It is not live and is not attributable to a particular query.

**Granularity:** aggregate per database/wait category since startup/reset.

**Scope:** built-in BC client for SaaS and OnPrem.

**Access:** Database Wait Statistics page; choose **Emit telemetry** to produce:

- RT0025 snapshot parent;
- RT0026 per-category entries.

**Evidence:**

- https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/database-wait-statistics
- https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-database-wait-statistics-trace

I did not inspect the underlying BC28 page/table implementation, so I cannot confirm that extensions have a supported public `Record "Database Wait Statistics"` API. Treat the built-in page and telemetry emission as supported; do not yet promise direct AL table access.

---

### 10. BCPT Application Insights telemetry

This is a second access path for claim 3.

**What it delivers:** `AL0000DGF` with operation, status, statement count, start/end, duration, session, codeunit, and run ID.

**Granularity:** BCPT scenario operation.

**Scope:** SaaS and OnPrem with BCPT and telemetry configured.

**Access:** Application Insights rather than reading internal table 149002.

**Evidence:**  
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-performance-toolkit-trace

This matters because `"BCPT Log Entry"` is `Access = Internal` at `BCPTLogEntry.Table.al:15`; consumers should not assume arbitrary extensions can read it directly.

---

### 11. OnPrem Windows Event Log / BC Server ETW

**What it delivers**

Long-running SQL events include SQL text, threshold/timing information, and, where AL caused the query, an AL call stack.

**Granularity:** per long-running SQL operation.

**Scope:** OnPrem only.

**Access:** Windows Event Viewer, PowerShell, ETW/PerfView. Threshold is controlled by `SqlLongRunningThreshold`.

**Evidence:**  
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/monitor-long-running-sql-queries-event-log

This is substantially the local predecessor/parallel transport to RT0005.

---

### 12. Business Central Windows performance counters

**What it delivers**

Service-instance aggregates including:

- server operations/sec and average operation time;
- open tenant/application SQL connections;
- query repositioning;
- throttled connections and transient errors;
- SQL heartbeat latency;
- command/result-set/primary-key/CalcFields cache requests and hit rates.

**Granularity:** time-series aggregate per BC service instance.

**Scope:** OnPrem only.

**Access:** Windows Performance Monitor/Data Collector Sets.

**Evidence:**  
https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/performance-counters

No SQL text or per-statement rows, but useful for distinguishing database/network/cache pressure from AL CPU.

---

### 13. OnPrem SQL Server plan-cache DMVs

Add at least:

- `sys.dm_exec_query_stats`
- `sys.dm_exec_sql_text`
- `sys.dm_exec_query_plan`

**What they deliver**

Per cached statement/plan:

- SQL text and plan;
- execution count;
- total/last/min/max elapsed and worker time;
- logical/physical reads and writes;
- rows **returned**;
- query and plan hashes.

**Granularity:** aggregate over the cached plan's lifetime. Rows disappear when plans are evicted/recompiled.

**Scope:** OnPrem SQL access only.

**Access:** T-SQL/SSMS under appropriate `VIEW SERVER PERFORMANCE STATE` or equivalent permissions.

**Evidence:**  
https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-query-stats-transact-sql

Do not map SQL Server `logical_reads` or `total_rows` directly to BC `sqlRowsRead`: logical reads are pages, while `total_rows` means rows returned, not rows examined.

For in-flight work add:

- `sys.dm_exec_requests`
- `sys.dm_os_waiting_tasks`
- `sys.dm_tran_locks`
- `sys.dm_exec_sessions`
- `sys.dm_exec_connections`

These provide current wait type/resource/time, blocker session, active SQL, transactions, and locks.

---

### 14. OnPrem SQL Server Query Store

**What it delivers**

Persistent, time-windowed:

- normalized SQL text;
- execution plans and plan history;
- execution counts;
- duration and CPU;
- logical/physical I/O;
- row counts;
- per-query wait categories;
- regressions and plan changes.

**Granularity:** query/plan/runtime-stat interval, not necessarily one row per execution.

**Scope:** OnPrem database access. Also exists internally in SaaS Azure SQL, but customers do not receive direct production SQL access.

**Access:** SSMS Query Store UI or `sys.query_store_*` views.

**Evidence:**  
https://learn.microsoft.com/en-us/sql/relational-databases/performance/monitoring-performance-by-using-the-query-store

This is better than `dm_exec_query_stats` for historical comparison because it survives plan-cache eviction.

---

### 15. OnPrem SQL Server Extended Events

**What it delivers**

A correctly configured session can capture per completed RPC/batch/statement:

- SQL text;
- duration and CPU;
- logical/physical reads and writes;
- row count;
- database/session/client information;
- query hash/plan handle;
- blocking, lock, wait, timeout, and deadlock events.

**Granularity:** per selected SQL execution/event.

**Scope:** OnPrem only.

**Access:** create an XE session using T-SQL or SSMS; consume ring-buffer/event-file output. Use predicates to restrict to the BC database/application name/session to control overhead.

**Evidence:**  
https://learn.microsoft.com/en-us/sql/relational-databases/extended-events/extended-events

This is the strongest OnPrem source for an exact capture window. SQL Trace/SQL Server Profiler is deprecated; prefer XE.

---

### 16. OnPrem SQL index/table DMVs

Add:

- `sys.dm_db_index_usage_stats` — seeks, scans, lookups, updates and last-use times;
- `sys.dm_db_index_operational_stats` — lock/latch and row-operation statistics;
- `sys.dm_db_partition_stats` — row counts and allocation;
- `sys.dm_db_index_physical_stats` — fragmentation;
- missing-index DMVs.

**Granularity:** table/index aggregate, generally since restart or database lifecycle event.

**Scope:** OnPrem only.

**Access:** T-SQL joined through `sys.tables`, `sys.indexes`, and BC physical table names.

Example evidence:  
https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-index-usage-stats-transact-sql

The `$ndo$…`, `NAV App$…`, `BC$…`, and company/app-GUID physical tables are primarily data or metadata, not operation-metric stores. They help map physical SQL names to BC objects/extensions, but the operation metrics come from DMVs, Query Store, XE, or BC telemetry. Do not list those physical tables themselves as metric sources without identifying an actual metric column.

---

### 17. Session Event is not a database metric source

Table 2000000111 contains session auditing fields—event type/time, session/user/client/server IDs—but no SQL count, rows, duration, or statement:

https://learn.microsoft.com/en-us/dynamics365/business-central/application/system/table/system.environment.session-event

It should not be added to the database-operation inventory.

---

### 18. Community/third-party tooling

- **Waldo BC Telemetry Buddy** consumes and analyzes existing Application Insights signals; it is not an independent metric producer. Waldo specifically confirms Additional Logging as a temporary all-SQL SaaS capture:  
  https://waldo.be/2026/02/24/troubleshooting-series-ep5-telemetry/
- I did not verify a Continia product that emits a distinct SQL metric stream. The Continia documentation search returned no usable result.
- The Vjeko/Freddy/Duilio searches found performance advice or older NAV material, but no additional BC28 per-operation metric source. Duilio's search-performance article is useful diagnostic advice, not a capture source.
- I would classify analyzers, Power BI apps, KQL packs, Telemetry Buddy, and similar products as **consumers**, unless their documentation proves they instrument and emit a new metric.

## Top 3 additions

1. **AL debugger database statistics** — statement + duration + approximate rows read + locks.
2. **RT0009 SQL query trace** — all SQL statement text and measured duration during verbose logging, including SaaS.
3. **OnPrem Query Store + Extended Events** — historical query/plan/wait aggregates plus per-execution capture.

```json evidence
{
  "files_checked": [
    "U:/Git/al-perf/docs/superpowers/research/2026-07-16-bc-sql-evidence-sources.md",
    "U:/Git/BC.history/System Application/Source/System Application/Performance Profiler/src/dotnet.al",
    "U:/Git/BC.history/System Application/Source/System Application/Performance Profiler/src/ProfilingNode.Table.al",
    "U:/Git/BC.history/testframework/performancetoolkit/Performance Toolkit/src/BCPTLogEntry.Table.al",
    "U:/Git/BC.history/System Application/Source/System Application/Performance Profiler/src/SamplingPerformanceProfiler.Codeunit.al",
    "U:/Git/BC.history/System Application/Source/System Application/Performance Profiler/src/SamplingPerfProfilerImpl.Codeunit.al"
  ],
  "searches_performed": [
    "search_search: site:learn.microsoft.com dynamics365 business central telemetry RT0005 RT0018 sqlRowsRead sqlExecutes database waits deadlock (failed HTTP 400)",
    "search_search: site:learn.microsoft.com dynamics365 business central telemetry Database Wait Statistics RT00 (failed HTTP 400)",
    "search_search: site:learn.microsoft.com dynamics365 business central performance profiler SQL call information rows read duration VS Code AL (failed HTTP 400)",
    "search_search: site:learn.microsoft.com dynamics365 business central AL Performance telemetry sqlRowsRead sqlExecutes page query report (failed HTTP 400)",
    "search_search: site:learn.microsoft.com dynamics365 business central Session Event table Database Wait Statistics virtual table SessionInformation Database codeunit (failed HTTP 400)",
    "search_search: Business Central on premises SQL Query Store Extended Events DMVs performance BC$ NavApp$ ndo$ (failed HTTP 400)",
    "search_search: site:waldo.be OR site:vjeko.com OR site:demiliani.com OR site:duiliotacconi.com OR site:freddysblog.com Business Central SQL profiler telemetry performance (failed HTTP 400)",
    "search_search: Continia Business Central SQL performance profiler rows read statements (failed HTTP 400)",
    "search_search: Business Central telemetry RT0005 SQL (failed HTTP 400)",
    "https://www.google.com/search?q=site%3Alearn.microsoft.com%2Fdynamics365%2Fbusiness-central+RT0005+sqlRowsRead (robots denied)",
    "https://www.bing.com/search?q=site%3Alearn.microsoft.com%2Fen-us%2Fdynamics365%2Fbusiness-central+RT0005+sqlRowsRead (robots denied)",
    "https://learn.microsoft.com/api/search?search=Business%20Central%20RT0005%20sqlRowsRead&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22RT0005%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22long-running%20SQL%22%20%22Business%20Central%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Business%20Central%22%20telemetry%20deadlock%20lock%20timeout&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Business%20Central%22%20report%20telemetry%20sqlRowsRead&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Database%20Wait%20Statistics%22%20%22Business%20Central%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Business%20Central%22%20profiler%20%22SQL%20information%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22AL%20Performance%22%20telemetry%20%22Business%20Central%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Session%20Event%22%20%22Business%20Central%22%20table&locale=en-us",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-sql-query-trace",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-long-running-sql-query-trace",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-overview",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/database-wait-statistics",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-database-lock-timeout-trace (404)",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/methods-auto/sessioninformation/sessioninformation-data-type",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-al-profiler (404)",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-performance-profiler (404)",
    "https://learn.microsoft.com/api/search?search=%22Analyzing%20report%20telemetry%22%20%22sqlRowsRead%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Database%20lock%20timeout%20telemetry%22%20%22Business%20Central%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Database%20deadlock%20telemetry%22%20%22Business%20Central%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Analyzing%20Database%20Wait%20Statistics%20Telemetry%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22AL%20profiler%22%20%22SQL%20statements%22%20%22Business%20Central%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22SQL%20call%20information%22%20%22Business%20Central%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Long%20running%20AL%20method%22%20telemetry%20%22Business%20Central%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Database%22%20data%20type%20%22Business%20Central%22%20SqlRowsRead&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22AL%20Profiler%22%20Business%20Central&locale=en-us",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-debugging",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-reports-trace",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-al-method-trace",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-database-wait-statistics-trace",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-database-locks-trace",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-database-deadlocks-trace",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/methods-auto/database/database-data-type",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-al-profiler-overview",
    "https://learn.microsoft.com/api/search?search=%22Table%20Information%22%20%22Business%20Central%22%20size%20records&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Table%20Information%22%20System%20Application%20Business%20Central&locale=en-us",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/monitor-long-running-sql-queries-event-log",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/monitoring-sql-database-deadlocks (404)",
    "https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-query-stats-transact-sql",
    "https://learn.microsoft.com/en-us/sql/relational-databases/performance/monitoring-performance-by-using-the-query-store",
    "https://learn.microsoft.com/en-us/sql/relational-databases/extended-events/extended-events",
    "https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-db-index-usage-stats-transact-sql",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/application/system/table/system.environment.session-event",
    "https://learn.microsoft.com/api/search?search=%22Session%20Event%22%20%22SQL%20Statements%22%20Business%20Central&locale=en-us",
    "https://learn.microsoft.com/api/search?search=site%3Alearn.microsoft.com%2Fen-us%2Fdynamics365%2Fbusiness-central%2Fapplication%2Fsystem%2Ftable%20%22Database%20Wait%20Statistics%22&locale=en-us",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/admin-view-table-information",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-virtual-tables",
    "https://learn.microsoft.com/api/search?search=%22Active%20Session%22%20%22SQL%20Statements%22%20Business%20Central&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22Database%20Wait%20Statistics%22%20table%20AL%20Business%20Central&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22BC%24%22%20%22NavApp%24%22%20Business%20Central%20SQL%20tables&locale=en-us",
    "https://www.waldo.be/wp-json/wp/v2/search?search=Business%20Central%20SQL%20profiler&per_page=10",
    "https://vjeko.com/wp-json/wp/v2/search?search=SQL%20performance&per_page=10",
    "https://demiliani.com/wp-json/wp/v2/search?search=Business%20Central%20SQL%20performance&per_page=10 (404)",
    "https://duiliotacconi.com/wp-json/wp/v2/search?search=Business%20Central%20SQL%20performance&per_page=10",
    "https://freddysblog.com/wp-json/wp/v2/search?search=Business%20Central%20performance%20profiler&per_page=10",
    "https://docs.continia.com/search?q=performance%20profiler%20SQL%20Business%20Central",
    "https://learn.microsoft.com/api/search?search=%22Continia%22%20%22performance%20profiler%22%20Business%20Central&locale=en-us",
    "https://api.github.com/search/repositories?q=Business+Central+performance+profiler+SQL",
    "https://api.github.com/search/repositories?q=ALProfiler+Business+Central (403)",
    "https://api.github.com/search/repositories?q=Business+Central+telemetry+performance+SQL (403)",
    "https://api.github.com/search/repositories?q=Dynamics+NAV+SQL+performance+tool (403)",
    "https://api.github.com/search/code?q=Continia+Performance+Profiler (401)",
    "https://waldo.be/wp-json/wp/v2/posts/318540",
    "https://www.google.com/search/about",
    "https://learn.microsoft.com/api/search?search=%22AL%20Performance%22%20%22Business%20Central%20Server%22&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22page%20view%22%20telemetry%20sqlRowsRead%20Business%20Central&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22query%20object%22%20telemetry%20sqlRowsRead%20Business%20Central&locale=en-us",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-webservices-trace",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/performance-counters-database (404)",
    "https://learn.microsoft.com/api/search?search=%22SQL%20Statements%20Executed%22%20%22performance%20counter%22%20Business%20Central&locale=en-us",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/monitor-server-using-performance-counters",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/business-central-performance-counters (404)",
    "https://learn.microsoft.com/api/search?search=%22Business%20Central%20Performance%20Counters%22&locale=en-us",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/performance-counters",
    "https://learn.microsoft.com/api/search?search=%22Performance%20Toolkit%20telemetry%22%20BCPT%20Business%20Central&locale=en-us",
    "https://learn.microsoft.com/api/search?search=%22BCPT%22%20%22sqlStatements%22%20telemetry&locale=en-us",
    "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/telemetry-performance-toolkit-trace"
  ],
  "confidence": "high"
}
```
