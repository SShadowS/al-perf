# Deep Analysis Optimization Log

Reference document for optimizing the deep analysis prompt and payload. Tracks what we've tried, what worked, and what hurt.

## Baseline

The Opus run `2026-03-08T21-44-06` is the constant baseline across all comparisons. Sonnet runs are compared against it using `scripts/compare-ai-quality.ts`, which sends both outputs to Claude for blind evaluation.

## Run History

| Run | Version | Prompt size | Payload size | Findings | vs Opus | Notes |
|-----|---------|-------------|-------------|----------|---------|-------|
| `2026-03-08T21-27-05` | v1 (original) | ~10K | 895 KB | 38 | **Sonnet 5-0** | No diagnostics, 10 call tree entries |
| `2026-03-08T23-17-21` | v2 (first improvements) | ~14K | 1,156 KB | 32 | Sonnet 3-1-1 | Added diagnostics, tableBreakdown, prompt rules, 15 call tree entries |
| `2026-03-08T23-40-14` | v3 (Session357 fixes) | ~14K | 1,156 KB | 31 | Sonnet 3-1-1 | Fixed cold-cache detection, added scaleNote, tableAccessMap guidance |
| `2026-03-09T00-27-12` | v4 (trimmed prompt) | ~11K | 1,156 KB | 39 | Sonnet 3-1-1 | Removed BC patterns section, softened rules, trimmed diagnostics guide |
| `2026-03-09T07-04-58` | v5 (near-v1 prompt) | ~10K | 1,156 KB | 38 | **Opus 3-1-1** | Removed all post-v1 prompt additions, kept diagnostics data |

## Key Findings

### 1. Smaller prompt = better analysis

v1 had the leanest prompt (~10K) and won 5-0. Every prompt addition reduced quality:

- **Evidence traceability rule** ("every number MUST be traceable") suppressed speculative-but-valuable findings like Cache Timeout = 0 and VSIFT insights
- **Finding count caps** ("limit to 3-5 for cold cache") artificially constrained output
- **BC-Specific Optimization Patterns** section was redundant — Sonnet already knows VSIFT, EnqueueBackgroundTask, session caching without being told
- **Detailed diagnostics usage guide** told Sonnet what to look for instead of letting it discover patterns

### 2. Smaller payload = better analysis

v1 and v5 have identical prompts but v5 has 29% more payload data. v1 won 5-0, v5 lost 3-1-1. The extra data (diagnostics, tableBreakdown, 15 vs 10 call tree entries) dilutes attention rather than helping.

### 3. Diagnostics data doesn't cause over-claiming (but doesn't help enough)

The cold-cache `diagnostics.coldCacheWarning` field works correctly even without prompt rules — v5 Sonnet correctly identified Session357's metadata pattern as info-level and said "no code fix required." But the overall payload bloat outweighs this benefit.

### 4. Prompt rules constrain more than they guide

Rules like "do NOT use critical severity for cold-cache profiles" and "ground evidence in payload data" made Sonnet follow rules instead of thinking freely. The v1 Sonnet naturally handled cold cache well (comparison noted "B correctly makes cold-cache the *primary* story") without any rules telling it to.

### 5. What Sonnet finds without help (v1's best unique findings)

These appeared in v1 with zero prompt guidance — Sonnet's natural BC domain knowledge:
- **Cache Timeout = 0** — zero-code-change configuration check
- **CODEUNIT.RUN cache destruction** — architectural insight about instance lifecycle
- **SetCITIsolatedStorage** — Isolated Storage write anti-pattern
- **VSIFT/SumIndex path** — BC-specific aggregate optimization
- **CheckMatchToWithTracking pre-filter** — efficiency-based algorithmic insight
- **6-path Reservation Entry analysis** — mapping multiple independent access paths
- **Efficiency scores cited** — quantitative evidence approach using the data's own metrics

### 6. What the diagnostics data enabled (v4 gains)

Some findings only appeared after diagnostics were added:
- **My Notifications GetFiltersAsText** (940/558 SQL hits) — appeared consistently in v2+
- **Wall-clock gap analysis** — from wallClockGapRatio
- **Health score contextualization** — from healthScoreNote

But these gains didn't outweigh the losses from payload bloat.

## Payload Components

| Component | Size impact | Value | Recommendation |
|-----------|------------|-------|----------------|
| `analysis` (hotspots, patterns, summary) | baseline | Essential | Keep |
| `callTree` (10 entries) | baseline | Essential | Keep at 10 |
| `callTree` (15 entries) | +5 entries | Marginal — extra entries are low-impact methods | Revert to 10 |
| `sourceSnippets` | varies | High — enables code-fix findings | Keep when available |
| `diagnostics.coldCacheScore/Warning` | ~100 bytes | Medium — prevents over-claiming on cold profiles | TBD |
| `diagnostics.wallClockGapRatio/Note` | ~200 bytes | Medium — enables gap analysis | TBD |
| `diagnostics.tableAccessMap` | ~1-2 KB | Low — Sonnet finds redundant access without it | TBD |
| `diagnostics.healthScoreNote` | ~100 bytes | Low — Sonnet contextualizes health score naturally | TBD |
| `diagnostics.scaleNote` | ~150 bytes | Low — Sonnet calibrates severity naturally | TBD |
| `diagnostics.transactionCount` | ~50 bytes | Low | TBD |
| `analysis.tableBreakdown` | ~4 KB/profile | Low — adds noise | Remove |

## Prompt Components

| Component | Size | Value | Status |
|-----------|------|-------|--------|
| Intro (BC expert, role description) | ~200 chars | Essential | Keep |
| Cross-method patterns (chains, fan-out, redundant access, events) | ~1.2K | High | Keep (v1 original) |
| Anomaly baselines (performance envelopes, env signatures, activity types) | ~2K | High | Keep (v1 original) |
| Business logic prompt (source-correlated, when --source) | ~1.5K | High | Keep (v1 original) |
| Code fix prompt (when --source) | ~1K | High | Keep (v1 original) |
| Output schema + rules 1-10 | ~1.5K | Essential | Keep |
| Rule 11 (cold cache handling) | ~250 chars | Low — Sonnet handles cold cache naturally | Removed in v5 |
| Rule 12 (evidence grounding) | ~200 chars | Negative — suppresses valuable inferences | Removed in v5 |
| Diagnostics usage guide | ~300 chars | Negative — over-prescriptive | Removed in v5 |
| BC-Specific Optimization Patterns | ~500 chars | Negative — Sonnet already knows these | Removed in v4 |
| Scale-awareness rules | ~400 chars | Low — scaleNote in diagnostics suffices | Removed in v4 |

## Next Steps

1. **Try v6: v1 payload + v1 prompt** — remove diagnostics and tableBreakdown from payload, revert call tree to 10 entries. This should reproduce v1's 5-0 result and confirm the payload-is-the-problem hypothesis.
2. **If confirmed**: selectively re-add only the highest-value diagnostics fields (coldCacheWarning, wallClockGapRatio) as a lightweight object, without tableBreakdown or tableAccessMap.
3. **Long-term**: consider whether the comparison AI (also Claude) has systematic biases in evaluation. Multiple runs of the same version would establish variance bands.
