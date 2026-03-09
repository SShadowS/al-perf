export const CROSS_METHOD_PROMPT = `## Cross-Method Call Tree Analysis

Analyze the call tree structure for these performance-critical patterns:

### Expensive Call Chains
Identify call chains where 3 or more methods contribute to aggregate high cost. Trace the full path from entry point to leaf and report the cumulative self+total time. A chain of individually modest methods can hide significant aggregate cost.

### Fan-Out Patterns
Look for orchestrator methods that call many child methods, each performing database operations. A single high-level method calling 10+ procedures that each do FindSet/FindFirst/Modify creates multiplicative DB round-trips. Report the fan-out degree and estimate total DB ops.

### Redundant Data Access
Detect when the same table is accessed through different call paths within the same top-level operation. The \`diagnostics.tableAccessMap\` pre-computes tables accessed by 2+ distinct callers — use it as a starting point, then trace the call tree to confirm redundancy.

### Event Cascade Overhead
Identify event publishers that trigger expensive subscriber chains. When an OnBefore/OnAfter event publisher appears in the profile, trace all subscribers it triggers and sum their cost. Report cases where the total subscriber cost exceeds the publisher's own direct work by a significant margin.
`;
