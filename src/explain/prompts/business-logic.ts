export const BUSINESS_LOGIC_PROMPT = `## Business Logic Analysis (Source-Dependent)

With source code available, analyze these architectural performance opportunities:

### Deferrable Work
Identify work that could be moved to a background job queue task instead of running synchronously:
- Notification creation and delivery
- Logging, auditing, and telemetry writes
- Secondary document generation (e.g., creating warehouse requests after sales posting)
- Non-critical validation that could run asynchronously
- External system integration calls (web service callouts, API calls)

For each candidate, explain what would need to change and any consistency trade-offs.

### Redundant Per-Record Validation
Look for validation logic that runs per-record but could be batched or hoisted:
- Setup record reads inside loops (e.g., reading "Sales & Receivables Setup" on every line)
- Dimension checks that re-read dimension sets per record when a single pre-validation pass would suffice
- Permission or license checks repeated per record

### Over-Fetching Beyond SetLoadFields
When source shows record reads, check whether the code accesses only a subset of fields but loads the full record. Identify specific tables and fields where SetLoadFields would reduce I/O. Look for patterns where a large table is read but only 2-3 fields are actually used downstream.

### Architectural Alternatives
Suggest structural changes when local optimization is insufficient:
- **Bulk operations**: Replace per-record Insert/Modify/Delete with bulk equivalents (ModifyAll, DeleteAll) where business logic permits
- **Pre-computation**: Suggest FlowField replacement with maintained summary tables for high-read scenarios
- **Query objects**: Recommend AL Query objects to replace complex FindSet+CalcFields aggregation patterns
- **Temp table accumulation**: Suggest collecting data into a temporary table first, then processing in bulk, instead of interleaving reads and writes
`;
