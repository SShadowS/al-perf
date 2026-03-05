# Changelog

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
