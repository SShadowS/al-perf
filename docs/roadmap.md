# Metrics & Capabilities Roadmap

> Brainstorming inventory for al-perf — cataloging every new metric, pattern, and analysis capability we could build, prioritized by effort vs impact.

**Date:** 2026-03-04
**Updated:** 2026-03-04
**Status:** Tier 1 complete. Roadmap for remaining items.

---

## Current State Summary

**Core metrics:** Profile-level timing (totalDuration, activeSelfTime, idleSelfTime, maxDepth, nodeCount), per-node timing (selfTime, totalTime, hitCount, depth, percentages), aggregations by method/object/app, two-profile comparison, wall clock vs CPU gap analysis, cost per hit, method efficiency score, call amplification factor, built-in vs custom code classification, line-level hotspot map, and hotspot-to-source deep linking.

**14 pattern detectors:**
- Profile-only (6): single-method-dominance, high-hit-count, deep-call-stack, repeated-siblings, event-subscriber-hotspot, **recursive-call**
- Source-correlated (4): calcfields-in-loop, modify-in-loop, record-op-in-loop, missing-setloadfields
- Source-only (4): nested-loops, unfiltered-findset, event-subscriber-with-loop-ops, event-subscriber-with-loops

**Source analysis (tree-sitter-al):** Extracts procedures, triggers, loops (4 types), record operations (19 types), nesting depth, event subscriber attributes.

**What's NOT analyzed yet:** timeDeltas variance, isIncompleteMeasurement, appVersion, frameIdentifier, variable types, table keys, CalcField formulas, event publisher attributes, commit/error patterns, table relations.

---

## Category 1: Low-Hanging Fruit (Existing Profile Data)

Fields already parsed and stored but never analyzed or surfaced.

### 1.1 Line-Level Hotspot Map :white_check_mark: DONE

For instrumentation profiles, break down each method's `positionTicks[]` to produce line-by-line time attribution. Currently we sum all positionTicks into a single selfTime per node. Each tick already has `line`, `column`, `executionTime`, and `ticks`. Surfacing these individually pinpoints the exact expensive line within a method.

- **Data source:** `RawPositionTick[]` on `ProcessedNode.positionTicks` (already stored)
- **Effort:** S (hours)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None. Instrumentation profiles only.
- **Key file:** `src/core/processor.ts` (calculateSelfTime)

### 1.2 Incomplete Measurement Flagging

Flag nodes where `isIncompleteMeasurement === true`. This field is defined in `RawProfileNode` but never checked. Incomplete measurements indicate the profiler was stopped mid-execution, making those nodes' timing data unreliable. Surface as a data quality warning.

- **Data source:** `RawProfileNode.isIncompleteMeasurement`
- **Effort:** S (hours)
- **Impact:** Medium (humans) / High (agents)
- **Dependencies:** None.

### 1.3 Built-in vs Custom Code Separation :white_check_mark: DONE

Use `isBuiltinCodeUnitCall` (defined but never checked) to separate system/platform overhead from custom application code. Enables a "your code only" view and helps developers focus on actionable code rather than BC infrastructure.

- **Data source:** `RawProfileNode.isBuiltinCodeUnitCall`
- **Effort:** S (hours)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None.

### 1.4 App Version Tracking

Include `appVersion` and `appPublisher` from `RawDeclaringApplication` in the `AppBreakdown` output. Currently only `appName` is used. Enables version-specific regression hunting and cross-version analysis.

- **Data source:** `RawDeclaringApplication.appVersion`, `appPublisher`
- **Effort:** S (hours)
- **Impact:** Medium (humans) / Medium (agents)
- **Dependencies:** None.

### 1.5 Wall Clock vs CPU Gap Analysis :white_check_mark: DONE

For instrumentation profiles, each node has `startTime` and `endTime`. The wall-clock duration `(endTime - startTime)` minus the computed `totalTime` reveals "unaccounted time" — time spent in I/O waits, SQL roundtrips, or other non-AL execution. **This is one of the most diagnostic metrics for identifying SQL bottlenecks.**

- **Data source:** `ProcessedNode.nodeStartTime`, `nodeEndTime`, `totalTime`
- **Effort:** S (hours)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None. Instrumentation profiles only.
- **Key file:** `src/types/processed.ts` (nodeStartTime/nodeEndTime already stored)

### 1.6 Sampling Jitter Analysis

Compute standard deviation, min, max, and coefficient of variation of `timeDeltas[]` (currently only averaged for samplingInterval). High jitter degrades selfTime estimate reliability. Irregular intervals can indicate system load, GC pauses, or I/O stalls during profiling.

- **Data source:** `ParsedProfile.timeDeltas[]`
- **Effort:** S (hours)
- **Impact:** Medium (humans) / High (agents)
- **Dependencies:** None. Sampling profiles only.

### 1.7 Sample Timeline Reconstruction

For sampling profiles, `samples[]` + `timeDeltas[]` form a timeline of execution. Producing a histogram shows how execution moves between methods over wall-clock time, revealing execution phases (e.g., "first 2s in data loading, next 5s in calculation").

- **Data source:** `ParsedProfile.samples[]`, `ParsedProfile.timeDeltas[]`
- **Effort:** M (days)
- **Impact:** High (humans) / Medium (agents)
- **Dependencies:** None.

---

## Category 2: New Profile-Based Analysis

New analytical capabilities built on the processed call tree and timing data.

### 2.1 Critical Path Extraction

Walk the call tree to find the single longest root-to-leaf path by totalTime. Answers "what is the single most important call chain to optimize?" Currently the tool reports individual hotspots but not the chain leading to them.

- **Data source:** `ProcessedProfile.roots`, parent/child relationships, `totalTime`
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None.

### 2.2 Call Amplification Factor :white_check_mark: DONE

For each parent-child edge, compute `child.hitCount / parent.hitCount`. High factors indicate inner loops or fan-out. Related to detectHighHitCount but surfaced as a continuous metric on every edge, not a binary pattern.

- **Data source:** `ProcessedNode.hitCount`, parent-child edges
- **Effort:** S (hours)
- **Impact:** Medium (humans) / High (agents)
- **Dependencies:** None.

### 2.3 Method Efficiency Score :white_check_mark: DONE

Compute `selfTime / totalTime` per method. Ratio near 1.0 = compute-bound (optimize this method). Near 0.0 = orchestrator (optimize its callees). Prevents recommending optimization of a method that just delegates.

- **Data source:** `MethodBreakdown.selfTime`, `MethodBreakdown.totalTime`
- **Effort:** S (hours)
- **Impact:** Medium (humans) / High (agents)
- **Dependencies:** None.

### 2.4 Object Interaction Graph

Build a directed graph of which BC objects call which, with edge weights based on call frequency and time. Reveals architectural coupling, bottleneck intermediaries, and circular dependencies between extensions.

- **Data source:** Parent-child relationships, `applicationDefinition.objectId/objectType`
- **Effort:** M (days)
- **Impact:** High (humans) / Medium (agents)
- **Dependencies:** None.

### 2.5 Tail Latency Detection

In instrumentation profiles, identify individual calls whose duration is significantly larger than the median for the same method. Reveals intermittent problems (lock contention, table scans) invisible in averages.

- **Data source:** `ProcessedNode.nodeStartTime/nodeEndTime`, grouped by function
- **Effort:** M (days)
- **Impact:** High (humans) / Medium (agents)
- **Dependencies:** Shares infrastructure with 1.5.

### 2.6 Recursive Call Detection :white_check_mark: DONE

Walk the call tree to detect direct or indirect recursion (method appearing as its own ancestor). Report recursion depth and total time. More specific and actionable than the existing deep-call-stack pattern which doesn't explain *why* it's deep.

- **Data source:** Call tree ancestry
- **Effort:** S (hours)
- **Impact:** High (humans) / Medium (agents)
- **Dependencies:** None.

### 2.7 Event Subscriber Chain Tracer

Trace full chains when an event publisher fires: publisher → all subscribers → transitive subscriber chains. Shows which events cause the most expensive cascades. Builds on detectEventSubscriberHotspot but provides structural detail.

- **Data source:** Call tree relationships, function name patterns (OnBefore/OnAfter/HandleOn)
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None. Enhanced by 3.12 (event catalog).

### 2.8 Time Concentration (Gini Coefficient)

Compute the Gini coefficient of selfTime across all non-idle methods. Near 1.0 = time concentrated in few methods (easy to optimize). Near 0.0 = uniformly spread ("death by a thousand cuts"). Tells whether targeted optimization will pay off.

- **Data source:** `MethodBreakdown.selfTime` array
- **Effort:** S (hours)
- **Impact:** Medium (humans) / High (agents)
- **Dependencies:** None.

### 2.9 Cost Per Hit (Average Time Per Invocation) :white_check_mark: DONE

Compute `selfTime / hitCount`. Normalizes away call frequency to reveal intrinsic cost. A method called 10,000 times at 100ms total (10us/call) is different from one called once at 100ms.

- **Data source:** `MethodBreakdown.selfTime`, `hitCount`
- **Effort:** S (hours)
- **Impact:** Medium (humans) / High (agents)
- **Dependencies:** None.

### 2.10 Subtree Drill-Down Report

Given a method of interest, show its subtree time attribution: "this method takes 40% of total time; of that, 60% is in SQL, 25% in events, 15% in own code." Enables focused investigation beyond flat hotspot lists.

- **Data source:** `ProcessedNode` call tree, `totalTime`, `selfTime`
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None.

### 2.11 Sibling Branch Cost Comparison

When a parent node has multiple distinct children (different methods), compare cost of each branch. Reveals asymmetric call patterns where one branch dominates.

- **Data source:** `ProcessedNode.children`, grouped by method identity
- **Effort:** S (hours)
- **Impact:** Medium (humans) / Medium (agents)
- **Dependencies:** None.

---

## Category 3: Deeper Tree-Sitter Source Analysis

New source code analysis capabilities using the tree-sitter-al grammar.

### 3.1 Cyclomatic Complexity

Count decision points (if, case, case_branch, while, for, foreach, repeat, logical AND/OR, conditional expressions) per procedure. High complexity correlates with maintenance difficulty and unpredictable performance.

- **Data source:** tree-sitter AST control flow node types
- **Effort:** M (days)
- **Impact:** Medium (humans) / Medium (agents)
- **Dependencies:** None.

### 3.2 Cognitive Complexity

Like cyclomatic but penalizes nested control flow more heavily. An `if` inside a `for` inside a `repeat` scores much higher than three sequential `if` statements. Better than raw `nestingDepth` which only captures maximum depth.

- **Data source:** tree-sitter AST, all control flow nodes + nesting context
- **Effort:** M (days)
- **Impact:** Medium (humans) / Medium (agents)
- **Dependencies:** None.

### 3.3 Record Variable Type Resolution

Extract `variable_declaration` from `var_section` to determine which variables are `Record` types and what table they reference. Transforms pattern messages from "FindSet on SalesLine" to "FindSet on Record 'Sales Line' (Table 37)." Dramatically improves actionability.

- **Data source:** tree-sitter AST — `var_section`, `variable_declaration`, `record_type`, `table_reference`
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None. Enhances existing patterns (missing-setloadfields, unfiltered-findset).

### 3.4 Method Signature Extraction

Extract procedure parameters and return types from the AST. Enables: identifying var Record parameters (unnecessary data copying), detecting complex signatures, more precise profile-to-source matching by parameter count/type.

- **Data source:** tree-sitter AST — `procedure`, `parameter_list`, `parameter`, `return_type`
- **Effort:** M (days)
- **Impact:** Medium (humans) / Medium (agents)
- **Dependencies:** None.

### 3.5 Table Field Reference Mapping

Track which table fields are accessed via `field_access` and `field_ref` nodes. Build "which procedures touch which fields" map. Validates whether SetLoadFields actually covers all fields later accessed. Can suggest exact SetLoadFields field list.

- **Data source:** tree-sitter AST — `field_access`, `field_ref`, correlated with variable types
- **Effort:** L (weeks)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** 3.3 (Variable Type Resolution).

### 3.6 CalcField Complexity Scoring

Parse `CalcFormula` from table declarations to understand FlowField complexity. SUM FlowFields over large tables are much more expensive than LOOKUP. Enables graduated severity: "CalcFields in loop on a SUM FlowField is critical; CalcFields on a LOOKUP is a warning."

- **Data source:** tree-sitter AST — `calc_field`, `calc_formula_property`, formula type nodes
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None. Enhances existing calcfields-in-loop detector.

### 3.7 Table Key Analysis

Parse `key_declaration` from table declarations. Cross-reference with SetRange/SetFilter calls to detect filter operations that can't use any defined key (= full table scan). High-value for catching SQL performance issues at the AL level.

- **Data source:** tree-sitter AST — `key_declaration`, `key_field_list`, cross-referenced with filter arguments
- **Effort:** L (weeks)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** 3.3 (for relating filters to their table's keys).

### 3.8 Procedure Size Metrics

Compute line count per procedure from existing `lineStart`/`lineEnd`. Already implicitly available in `ProcedureInfo` but not surfaced. Useful when combined with hotspots: "the most expensive methods that are also the longest."

- **Data source:** `ProcedureInfo.lineStart`, `ProcedureInfo.lineEnd` (already computed)
- **Effort:** S (hours)
- **Impact:** Low (humans) / Low (agents)
- **Dependencies:** None.

### 3.9 Commit/Error in Loop Detection

Detect `Commit()` inside loops — a severe anti-pattern that forces transaction flushes. Also detect `Error()` and `TestField()` calls inside loops (validation logic that could be batched). Follows existing record-op-in-loop detection architecture.

- **Data source:** tree-sitter AST — `call_expression` matching Commit/Error/TestField, loop context
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None.

### 3.10 Table Relationship Graph

Parse `table_relation_property`, `calc_field_ref`, and `lookup_where_conditions` from table declarations to build a graph of table relationships (foreign keys, FlowFields, lookups). Enables understanding which tables are central vs. peripheral.

- **Data source:** tree-sitter AST — table relation and FlowField reference nodes
- **Effort:** L (weeks)
- **Impact:** High (humans) / Medium (agents)
- **Dependencies:** Benefits from 3.6.

### 3.11 Code Duplication Detection

Hash normalized AST subtrees to find structurally identical or similar code blocks. Duplicated code means duplicated performance problems — fixing one without the others leaves the bug in place.

- **Data source:** tree-sitter AST — full subtree comparison with normalized hashing
- **Effort:** L (weeks)
- **Impact:** Medium (humans) / Low (agents)
- **Dependencies:** None.

### 3.12 Event Publisher/Subscriber Catalog

Parse `[IntegrationEvent]`, `[BusinessEvent]` publisher declarations and `[EventSubscriber]` attributes. Build a publisher→subscriber mapping catalog. Currently only `[EventSubscriber]` is detected. Enables "how many subscribers fire when event X is raised?" analysis.

- **Data source:** tree-sitter AST — `attribute_item`, `attribute_arguments` matching event attributes
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None. Enhances 2.7 (Event Chain Tracer).

### 3.13 Temporary Table Detection

Detect `temporary` keyword on record variable declarations and `SourceTableTemporary` on pages. Record operations on temporary tables are in-memory (no SQL) — should be excluded from N+1 query warnings. **Eliminates false positives in pattern detection.**

- **Data source:** tree-sitter AST — `temporary` keyword, `use_temporary_property`
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** 3.3 for full effectiveness.

### 3.14 With Statement Detection

Detect deprecated `with` statement usage. Warns about potential pattern detection blind spots (implicit record variable scopes make record ops harder to attribute).

- **Data source:** tree-sitter AST — `with_statement`
- **Effort:** S (hours)
- **Impact:** Low (humans) / Medium (agents)
- **Dependencies:** None.

---

## Category 4: New Analysis Dimensions

Entirely new ways to view, query, and present the data.

### 4.1 "What If" Optimization Estimator

Given a detected pattern, estimate time savings if fixed. "CalcFields in loop, 500 iterations, 2ms per call → fixing saves ~998ms." Transforms patterns from "you have a problem" to "here's the ROI of fixing it." The `impact` field on DetectedPattern already exists but stores raw selfTime, not estimated savings.

- **Data source:** Profile timing + pattern metadata + heuristic cost models
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None.

### 4.2 Hotspot-to-Source Deep Link :white_check_mark: DONE

For each hotspot method, resolve its source file location via `matchToSource` and include file path, line range, and optionally code snippet. Currently source correlation only happens for pattern detection, not for the hotspot list itself.

- **Data source:** `MethodBreakdown` + `SourceIndex` via `matchToSource` (already exists)
- **Effort:** S (hours)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** Requires source path.

### 4.3 Profile Health Score

Single 0-100 score summarizing overall profile health. Factors: Gini coefficient, pattern counts, idle %, jitter, sample count, duration. Enables CI/CD gates on a holistic metric rather than individual pattern counts.

- **Data source:** Combination of existing and new metrics
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** Benefits from 1.6 (jitter) and 2.8 (Gini) but works without them.

### 4.4 Per-App Scoped Analysis

Complete analysis (hotspots, patterns, call tree) scoped to a single app/extension. Recompute percentages relative to the app's own time, show internal call graph, show boundary calls (what it calls externally, what calls it). Currently `--app-filter` only filters the hotspot list.

- **Data source:** All profile data, filtered by `declaringApplication.appName`
- **Effort:** M (days)
- **Impact:** High (humans) / Medium (agents)
- **Dependencies:** None.

### 4.5 Table-Centric View

Pivot analysis around database tables. For each table: total time in operations (FindSet, Modify, Insert, Delete, CalcFields), number of distinct call sites, filter usage, SetLoadFields usage. Answers "which tables are the bottleneck?"

- **Data source:** Profile nodes with `objectType === "TableData"`, source variable types
- **Effort:** L (weeks)
- **Impact:** High (humans) / Medium (agents)
- **Dependencies:** 3.3 for full source-side correlation.

### 4.6 Per-Instance Method Statistics

For instrumentation profiles: compute min/max/mean/median/p95/p99 of selfTime across multiple calls of the same method. Reveals variance — a method averaging 1ms but sometimes taking 100ms needs different optimization than one consistently at 5ms.

- **Data source:** Multiple `ProcessedNode` entries per method, with per-node timing
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** Related to 2.5 (Tail Latency).

### 4.7 Object Type Behavior Analysis

Aggregate by AL object type (Page, Codeunit, Table, Report, Query, XMLport). Shows whether the performance issue is in UI (Page), logic (Codeunit), or data (Table) layer.

- **Data source:** `ProcessedNode.applicationDefinition.objectType`, aggregated timing
- **Effort:** S (hours)
- **Impact:** Medium (humans) / Medium (agents)
- **Dependencies:** None.

---

## Category 5: Cross-Profile Analysis

Capabilities that operate across multiple profiles over time.

### 5.1 Performance History Store

Store key metrics from each analysis run in a local JSON/SQLite database, keyed by timestamp and optionally git commit hash. Enables N-profile trend queries. Currently comparison only handles two profiles at a time.

- **Data source:** `AnalysisResult` outputs over time
- **Effort:** L (weeks)
- **Impact:** High (humans) / Medium (agents)
- **Dependencies:** None.

### 5.2 Automated Regression Alerting

In CI/CD, auto-compare against stored baseline with statistical significance thresholds. Not just "did it get bigger" but "did it get *significantly* bigger given normal variation."

- **Data source:** Current result + stored baselines
- **Effort:** L (weeks)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** 5.1.

### 5.3 Method Performance Timeline

Track one method's selfTime, hitCount, and patterns across multiple profiles. "Did my optimization of ProcessRecords actually help?" Requires correlated profile storage.

- **Data source:** Multiple `AnalysisResult` entries correlated by method identity
- **Effort:** M (days) (given 5.1 exists)
- **Impact:** High (humans) / Medium (agents)
- **Dependencies:** 5.1.

### 5.4 Multi-Profile Aggregate View

Analyze a collection of profiles (different users/scenarios). Find methods consistently slow across all profiles vs. scenario-specific. Produces intersection/union view of hotspots and patterns.

- **Data source:** Multiple `AnalysisResult` instances
- **Effort:** M (days)
- **Impact:** Medium (humans) / Medium (agents)
- **Dependencies:** None (works on ad-hoc collections).

### 5.5 Pattern-Level Comparison

Extend ComparisonResult to include pattern differences: new patterns introduced, patterns resolved, severity changes. "Your change resolved the repeated-siblings pattern" or "introduced a new CalcFields-in-loop."

- **Data source:** Two `AnalysisResult` instances, pattern list comparison
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** None.

---

## Category 6: Data Quality & Reliability

Confidence scoring, measurement health, and metadata.

### 6.1 Profile Confidence Score

0-100% score based on: sampling jitter, incomplete measurements, idle ratio, sample count, profile duration. Attached to every AnalysisResult. "We are 95% confident" vs "high jitter, wide error bars."

- **Data source:** Profile metadata, timeDeltas, incomplete measurement flags
- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)
- **Dependencies:** Benefits from 1.2, 1.6 but works without them.

### 6.2 Profile Type Advisory

Warn when profile type is suboptimal for the analysis: "sampling profile with only 50 samples; results may not be statistically significant" or "instrumentation profile; hitCount includes probe overhead."

- **Data source:** `ParsedProfile.type`, sample count, node count
- **Effort:** S (hours)
- **Impact:** Medium (humans) / Medium (agents)
- **Dependencies:** None.

### 6.3 Source Correlation Coverage Report

Report what % of hotspot methods were matched to source. "85% matched; 15% unmatched (likely base app)." Helps understand scope of source-correlated analysis.

- **Data source:** `matchToSource` results vs total hotspot count
- **Effort:** S (hours)
- **Impact:** Medium (humans) / Medium (agents)
- **Dependencies:** Requires source path.

### 6.4 Profile Anomaly Detection

Detect: negative time values, children totalTime > parent totalTime, zero hitCount with non-zero selfTime, timing outside profile window. Catches instrumentation bugs, truncation, or data corruption.

- **Data source:** All processed node data, cross-validation
- **Effort:** M (days)
- **Impact:** Medium (humans) / High (agents)
- **Dependencies:** None.

### 6.5 Effective Coverage Estimate

Estimate what % of actual execution the profiler captured. If 10s wall-clock but only 2s of selfTime, effective coverage is 20%. Low coverage may indicate wrong profiling window or system code dominance.

- **Data source:** `totalDuration`, `activeSelfTime`, `idleSelfTime`
- **Effort:** S (hours)
- **Impact:** Medium (humans) / Medium (agents)
- **Dependencies:** None.

### 6.6 Per-Method Statistical Confidence

For sampling profiles, compute margin of error per method based on sample count. "selfTime: 150ms +/- 30ms." Prevents over-interpreting noise in low-sample methods.

- **Data source:** `ProcessedNode.hitCount`, statistical formulas
- **Effort:** M (days)
- **Impact:** Medium (humans) / High (agents)
- **Dependencies:** None.

---

## AL-Flamegraph Integration

The [AL-Flamegraph](https://github.com/SShadowS/AL-Flamegraph) service converts `.alcpuprofile` files into interactive SVG flamegraphs via `POST /upload`. It's complementary to al-perf: AL-Flamegraph visualizes, al-perf analyzes.

### F.1 Folded Stack Export Format

Add `--format folded` output to produce folded stack format (semicolon-separated stacks with hit counts). Compatible with `flamegraph.pl` and the AL-Flamegraph API.

- **Effort:** S (hours)
- **Impact:** Medium (humans) / Low (agents)

### F.2 MCP Tool: visualize_flamegraph

MCP tool that POSTs profile data to AL-Flamegraph API, returns SVG. Enables AI agents to generate visual flamegraphs alongside textual analysis.

- **Effort:** M (days)
- **Impact:** High (humans) / High (agents)

### F.3 Annotated Flamegraph

Mark detected patterns directly on the flamegraph: color critical path nodes differently, highlight pattern-flagged methods, add hover tooltips with pattern descriptions.

- **Effort:** M (days)
- **Impact:** High (humans) / Medium (agents)
- **Dependencies:** F.1 or F.2.

---

## Priority Tiers

### Tier 1: Immediate Wins (S effort, High impact) :white_check_mark: ALL DONE

All 8 items implemented and merged to master.

| # | Item | Status |
|---|------|--------|
| 1.5 | Wall Clock vs CPU Gap Analysis | :white_check_mark: Done |
| 1.3 | Built-in vs Custom Separation | :white_check_mark: Done |
| 1.1 | Line-Level Hotspot Map | :white_check_mark: Done |
| 2.9 | Cost Per Hit | :white_check_mark: Done |
| 2.6 | Recursive Call Detection | :white_check_mark: Done |
| 2.3 | Method Efficiency Score | :white_check_mark: Done |
| 4.2 | Hotspot-to-Source Deep Link | :white_check_mark: Done |
| 2.2 | Call Amplification Factor | :white_check_mark: Done |

### Tier 2: High-Value Medium Effort (M effort, High impact)

Worth investing days for significant capability uplift:

| # | Item | Why It's Tier 2 |
|---|------|-----------------|
| 2.1 | Critical Path Extraction | The single most impactful new analysis capability. |
| 3.3 | Variable Type Resolution | Unlocks table-aware patterns — transforms all existing source patterns. |
| 3.13 | Temporary Table Detection | Eliminates false positives. High signal improvement. |
| 4.1 | "What If" Estimator | Quantifies fix ROI. Transforms pattern output from diagnostic to prescriptive. |
| 2.7 | Event Chain Tracer | Events are the #1 "hidden" performance cost in BC. |
| 5.5 | Pattern-Level Comparison | Validates optimization outcomes. Natural extension of compare. |
| 6.1 | Profile Confidence Score | Trust calibration for all recommendations. |
| 3.9 | Commit/Error in Loop | Catches severe anti-pattern. Follows existing architecture. |
| 3.6 | CalcField Complexity Scoring | Graduates severity of existing pattern. High-value refinement. |
| 3.12 | Event Publisher/Subscriber Catalog | Event architecture visibility. Enhances 2.7. |
| F.2 | MCP Flamegraph Tool | Visual output for agents. |
| 2.10 | Subtree Drill-Down | Enables focused investigation. |
| 4.6 | Per-Instance Method Statistics | Reveals variance invisible in averages. |
| 4.3 | Profile Health Score | Single tracking metric for CI/CD. |

### Tier 3: Strategic Investments (L effort, High impact)

Worth weeks of effort for transformative capabilities:

| # | Item | Why It's Tier 3 |
|---|------|-----------------|
| 3.5 | Field Reference Mapping | Validates SetLoadFields correctness. Can suggest exact field lists. |
| 3.7 | Table Key Analysis | Catches missing index issues. Very high SQL optimization value. |
| 5.1 | Performance History Store | Enables trend tracking. Foundation for 5.2, 5.3. |
| 4.5 | Table-Centric View | DBA-oriented analysis, unique perspective. |
| 3.10 | Table Relationship Graph | Data model understanding. |

### Tier 4: Nice-to-Haves

Lower priority but still valuable:

| # | Item | Effort | Note |
|---|------|--------|------|
| 1.2 | Incomplete Measurement Flags | S | Easy data quality win |
| 1.6 | Sampling Jitter | S | Easy reliability metric |
| 1.4 | App Version Tracking | S | Enables version comparison |
| 2.8 | Gini Coefficient | S | Strategic guidance metric |
| 4.7 | Object Type Behavior | S | Simple aggregation |
| 6.2 | Profile Type Advisory | S | Avoid misinterpretation |
| 6.5 | Coverage Estimate | S | Scope qualification |
| 6.3 | Source Match Rate | S | Completeness metric |
| 3.8 | Procedure Size Metrics | S | Coarse but easy |
| 3.14 | With Statement Detection | S | Niche concern |
| F.1 | Folded Stack Export | S | Utility format |
| 1.7 | Sample Timeline | M | Visualization-oriented |
| 2.4 | Object Interaction Graph | M | Architectural visibility |
| 2.5 | Tail Latency Detection | M | Intermittent problems |
| 4.4 | Per-App Scoped Analysis | M | ISV-focused |
| 5.4 | Multi-Profile Aggregate | M | Scenario comparison |
| 3.1 | Cyclomatic Complexity | M | Standard metric |
| 3.2 | Cognitive Complexity | M | Better than nesting depth |
| 3.4 | Method Signatures | M | Better source matching |
| 6.4 | Profile Anomaly Detection | M | Data quality |
| 6.6 | Per-Method Confidence | M | Statistical rigor |
| 2.11 | Sibling Branch Comparison | S | Navigational aid |
| 5.2 | Automated Regression | L | Requires 5.1 |
| 5.3 | Method Timeline | M | Requires 5.1 |
| 3.11 | Code Duplication | L | Not directly perf-related |

---

## Dependency Graph

```
3.3 Variable Type Resolution
 ├── 3.5 Field Reference Mapping
 │    └── (validates SetLoadFields correctness)
 ├── 3.7 Table Key Analysis
 │    └── (detects unindexed filters)
 ├── 3.13 Temporary Table Detection
 │    └── (eliminates false positives)
 └── 4.5 Table-Centric View
      └── (source-side table correlation)

3.6 CalcField Complexity
 └── 3.10 Table Relationship Graph (benefits from)

3.12 Event Publisher/Subscriber Catalog
 └── 2.7 Event Chain Tracer (enhanced by)

5.1 Performance History Store
 ├── 5.2 Automated Regression Alerting
 └── 5.3 Method Performance Timeline

1.5 Wall Clock Gap Analysis
 └── 2.5 Tail Latency Detection (shares infrastructure)

1.2 Incomplete Measurement + 1.6 Jitter
 └── 6.1 Profile Confidence Score (enhanced by)

F.1 Folded Stack Export
 └── F.3 Annotated Flamegraph

2.8 Gini Coefficient
 └── 4.3 Profile Health Score (factor in)
```

---

## Key Files for Implementation

| File | New Capabilities It Would Gain |
|------|-------------------------------|
| `src/core/processor.ts` | ~~1.3 built-in classification~~ :white_check_mark:, 1.2 incomplete flags |
| `src/core/aggregator.ts` | ~~1.1 line hotspots, 1.5 gap analysis, 2.2 amplification, 2.3 efficiency, 2.9 cost per hit~~ :white_check_mark:, 1.4 app version, 4.7 object type view |
| `src/core/patterns.ts` | ~~2.6 recursion detector~~ :white_check_mark:, 2.7 event chains |
| `src/core/analyzer.ts` | ~~1.3 builtinSelfTime, 4.2 source deep link~~ :white_check_mark:, 2.1 critical path, 2.10 subtree drill-down, 5.5 pattern comparison |
| `src/source/indexer.ts` | 3.3 variable types, 3.4 signatures, 3.6 CalcField formulas, 3.7 keys, 3.9 commit detection, 3.12 events, 3.13 temporary |
| `src/source/source-patterns.ts` | Enhanced patterns with table names, temporary exclusion, CalcField severity |
| `src/source/source-only-patterns.ts` | 3.9 commit-in-loop, 3.14 with statement |
| `src/output/types.ts` | ~~builtinSelfTime~~ :white_check_mark:, new fields for future capabilities |
| `src/mcp/tools/` | F.2 flamegraph tool, new MCP endpoints for drill-down queries |
