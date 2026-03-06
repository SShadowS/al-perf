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
`;
