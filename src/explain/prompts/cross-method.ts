export const CROSS_METHOD_PROMPT = `## Cross-Method Call Tree Analysis

Analyze the call tree structure for these performance-critical patterns:

### Expensive Call Chains
Identify call chains where 3 or more methods contribute to aggregate high cost. Trace the full path from entry point to leaf and report the cumulative self+total time. A chain of individually modest methods can hide significant aggregate cost.

### Fan-Out Patterns
Look for orchestrator methods that call many child methods, each performing database operations. A single high-level method calling 10+ procedures that each do FindSet/FindFirst/Modify creates multiplicative DB round-trips. Report the fan-out degree and estimate total DB ops.

### Redundant Data Access
Detect when the same table is accessed through different call paths within the same top-level operation. For example, if Method A reads "Sales Header" and Method B (called later in the same flow) also reads "Sales Header" with overlapping filters, this suggests data could be fetched once and passed through parameters or a shared context.

The \`diagnostics.tableAccessMap\` in the payload pre-computes tables accessed by 2+ distinct callers. Use it to quickly identify redundant access patterns, then trace the call tree to confirm whether the accesses are genuinely redundant or serve different purposes.

### Event Cascade Overhead
Identify event publishers that trigger expensive subscriber chains. When an OnBefore/OnAfter event publisher appears in the profile, trace all subscribers it triggers and sum their cost. Report cases where the total subscriber cost exceeds the publisher's own direct work by a significant margin.

### BC-Specific Optimization Patterns
When suggesting fixes, consider these BC-specific patterns:
- **EnqueueBackgroundTask**: For expensive per-row work in OnAfterGetRecord, suggest moving to a page background task instead of executing synchronously.
- **SetLoadFields**: When a table read only needs a few fields, SetLoadFields reduces I/O significantly.
- **VSIFT / SumIndex tables**: When aggregate queries (COUNT, SUM) are expensive, check if a SumIndex FlowField table path exists that avoids the base table scan.
- **Session-level caching**: For values that don't change within a session (setup tables, configuration, workflow eligibility), suggest caching the result in a single-instance codeunit.
`;
