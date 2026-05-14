# What Microsoft Should Open in the Performance Profiler

## The Asks

### 1. Public AL access to captured profiles (Profiler Schedules)

Table 1924 (`Performance Profiles`) contains the profile data, activity metadata, SQL stats, and session info for every scheduled profiler run. Partners need programmatic access to this data to build automated analysis workflows: batch analysis of scheduled runs, CI/CD gates, regression detection.

Today the only way to access completed schedule data is through the UI. The data is there, we just can't get to it from AL code.

Fields needed from Table 1924:

| Field | Why |
|-------|-----|
| `Profile` (Blob) | The actual profiling data to analyze |
| `Activity ID` | Identifies the profiled activity |
| `Client Type` | Categorize by client type (Web, Background, WebService) |
| `Activity Description` | Human-readable description of what was profiled |
| `Starting Date-Time` | When the profiling started |
| `Activity Duration` | Total activity duration |
| `Duration` | AL execution duration |
| `Sql Call Duration` | SQL time spent |
| `Sql Statement Number` | Number of SQL statements |
| `Http Call Duration` | HTTP time spent |
| `Http Call Number` | Number of HTTP calls |
| `User Name` (FlowField) | Who triggered the activity |
| `Client Session ID` | Session identifier |
| `Schedule ID` | Link to the schedule that triggered this profile |

Nice-to-have: `Description` from Table 1932 (`Performance Profile Scheduler`) for display enrichment.

### 2. Event raised when a profile is created (Profiler Schedules)

Zero `[IntegrationEvent]` or `[BusinessEvent]` publishers exist across all profiler codeunits today. When a scheduled run completes, partners should be able to subscribe and react. This is the foundation for any "collect profiles automatically, analyze them automatically" workflow.

Without this, the only option is manual: a user opens a page, clicks a button. An event-driven approach would enable background processing and full automation.

### 3. Cloud scope access to profiler data

This is the biggest blocker for SaaS. Tables 1924 and 1932 are not accessible from Cloud-scoped extensions. The companion app (al-perf-bc) had to be changed from Cloud to OnPrem scope specifically because of this, which means SaaS customers cannot use batch analysis at all.

Single-profile analysis works in SaaS (Page 1911 is Cloud-scoped, CU 1924 is public), but batch analysis of scheduled profiles is completely blocked. How this is exposed (changing table scope, adding a Cloud-scoped API, a facade codeunit) is up to Microsoft. We just need a way to get to the data.

### 4. Page extensibility for profiler list pages

Pages 1931 (`Performance Profile List`) and 1933 (`Perf. Profiler Schedules List`) need to be extensible in Cloud scope so partners can add actions (like "Analyze" or "Analyze Batch") to these pages for SaaS customers.

### 5. Table extensibility on 1924 and 1932 (nice-to-have)

Being able to extend these tables with `tableextension` would allow storing analysis results back on the records and showing analysis status or scores directly in the profiler list pages. Not essential for core functionality, but enables richer UI integration.

## Locked-Down Objects

These codeunits are `Access = Internal` with no integration events:

| Object | Name | Impact |
|--------|------|--------|
| CU 1925 | Sampling Perf. Profiler Impl. | Cannot hook into profiling workflow |
| CU 1923 | Profiling Data Processor | Cannot extend data processing |
| CU 1932 | Scheduled Perf. Profiler Impl. | Cannot react to schedule completions |

## What's Already Good

- **CU 1924** ("Sampling Performance Profiler") is `Access = Public` with a clean API: `Start()`, `Stop()`, `IsRecordingInProgress()`, `GetData()`, `GetProfilingNodes()`, `GetProfilingCallTree()`
- **Page 24/1911** ("Performance Profiler") is extensible, partners can add page extensions — single-profile analysis works today because of this
- **Profiler Schedules** (BC25) solved the capture problem for time-based profiling
- The `.alcpuprofile` format is rich: call tree with timing, hit counts, app attribution, object metadata

The capture side works. The gap is in what comes after capture: no programmatic access to results, no events, no Cloud scope access to the data.
