export const ANOMALY_PROMPT = `## Anomaly Detection and BC Domain Baselines

Use these Business Central performance baselines to identify anomalies:

### Typical Performance Envelopes
- Sales order posting (< 50 lines): 1-5 seconds
- Sales order posting (50-500 lines): 5-30 seconds
- Item journal posting (< 100 lines): 1-5 seconds
- General journal posting (< 50 lines): 1-3 seconds
- Report generation (simple list): 2-10 seconds
- Page load (list page, first 50 records): < 1 second
- Page load (card page): < 0.5 seconds
- Dimension validation per line: < 10ms
- Approval workflow trigger: < 2 seconds

Flag any profile whose total duration significantly exceeds these baselines for its detected activity type and scale.

### Environmental Signatures (NOT Code Issues)
Do NOT recommend code fixes for these infrastructure/environmental patterns:
- **Cold metadata cache**: Disproportionate time in system metadata queries ("Application Object Metadata", "Translation Text", metadata SQL). Signature: high hit counts on metadata tables with no application logic driving them. This is transient after service tier restart.
- **JIT compilation overhead**: First execution after deployment shows inflated times across all code paths uniformly. Subsequent runs normalize.
- **Permission check overhead**: Excessive time in permission validation indicates configuration/licensing concerns, not code bugs. Signature: many calls to permission-related system methods.
- **Data volume vs. code patterns**: High hit counts on FindSet/FindFirst may indicate large tables with missing indexes or filters rather than code issues. Distinguish between query pattern problems and data volume problems.

### Activity-Type Baselines
Different activity types have different acceptable performance profiles:
- **Background / Job Queue**: Throughput matters more than latency. Higher total times are acceptable if per-record processing is efficient.
- **Web Client (interactive)**: User-perceived latency is critical. Flag anything over 2 seconds for a single user action.
- **Web Service / API**: Consistent response times matter. Flag high variance and any call exceeding SLA thresholds (typically 5-10 seconds).
- **Scheduled tasks**: Total duration matters for scheduling windows. Flag if approaching or exceeding the scheduled interval.

### Using the diagnostics Object
The payload includes a \`diagnostics\` object with pre-computed signals. Use these to guide your analysis:
- **\`coldCacheWarning: true\`**: This profile is dominated by metadata cache loading. Make this the PRIMARY finding. State clearly that this is a transient infrastructure issue, not a code problem. Do not recommend code-level optimizations for metadata loading. The developer should re-profile after the cache is warm.
- **\`wallClockGapRatio > 0.5\`**: Large gap between wall-clock and CPU time suggests SQL Server wait time, network I/O, or lock contention. Read \`wallClockGapNote\` and incorporate it. Suggest SQL Server Extended Events or wait statistics as a next diagnostic step.
- **\`transactionCount > 20\`**: High transaction density may indicate excessive implicit commit boundaries. Consider whether operations could be batched into fewer transactions.
- **\`tableAccessMap\`**: Lists tables accessed by multiple distinct code paths. Use this to identify redundant data access — if the same table is read through 3+ different call paths, it's likely a consolidation opportunity.
- **\`healthScoreNote\`**: If present, include this interpretation of the health score in your narrative to avoid misinterpretation.
`;
