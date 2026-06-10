# Phase P2: Fusion UX — hotspot static-cause annotation + runtime-prioritized findings — Design

> **Context:** P1 (the al-sem fusion substrate) shipped on `feat/alsem-fusion`: `fuseProfile(methods,
> workspaceDir) → FusedModel` (the runner shells out to `alsem fingerprint --inventory-only` + `analyze`;
> `correlate` produces the honest 6-status side-map `attributions: Map<methodKey, SemanticAttribution>` +
> `coldRoutines`/`orphanFindings`/`unkeyableFindings`/`correlationSummary`). P2 is the USER-FACING PAYOFF:
> the two fusion views surfaced across ALL al-perf surfaces (CLI + library + MCP + web). Additive +
> opt-in — al-perf is byte-unchanged when fusion is off. Built on `feat/alsem-fusion`.

## Goal
Turn the FusedModel into two consumable views and render them everywhere:
1. **Hotspot → static cause:** each runtime hotspot annotated with its correlated al-sem finding(s) —
   the detector, title, rootCause, source anchor, fix hint, confidence — and the correlation status.
2. **Runtime-prioritized findings:** al-sem's findings ranked by the CPU cost of the routine they sit
   on — "the static findings that are actually burning time" (the inverse of an unweighted finding list).

## Components (staged P2.0 → P2.3)

### P2.0 — derived fusion views (the shared data layer; PURE, deterministic)
`src/semantic/views.ts`:
- `annotateHotspots(fused: FusedModel, methods: MethodBreakdown[]) → HotspotAnnotation[]` — for each
  AL hotspot, its `SemanticAttribution` (findings + status + `attributionConfidence` + `matchedClean` +
  `reason`) joined to the method's CPU metrics. `HotspotAnnotation = { method: MethodBreakdown, status,
  attributionConfidence, findings: FindingSummary[], matchedClean, reason?, stableRoutineId? }`. Ordered
  by the method's existing hotspot order (selfTime desc). For `ambiguous` the findings carry the flag so
  no renderer says "caused by X" (the contract from P1).
- `prioritizeFindings(fused: FusedModel, methods: MethodBreakdown[]) → PrioritizedFinding[]` — flatten
  each attribution's findings to `{ finding: FindingSummary, method: MethodBreakdown, totalTimePercent,
  selfTimePercent, gapTime?, attributionConfidence, status }`; **rank by `totalTimePercent` desc** (a
  finding's runtime impact includes its callees/SQL; `selfTimePercent`/`gapTime` shown alongside), ties
  broken by `(selfTimePercent desc, finding.fingerprint, finding.id)` for determinism. Findings on
  `cold`/`blind-spot`/`unkeyable` routines have NO runtime sample → a separate `unweightedFindings` list
  (or weight 0, sorted last + flagged) — never silently dropped (a `cold` finding = "statically flagged,
  not hot" is itself a useful signal). De-dup a finding that appears under multiple ambiguous keys by
  `fingerprint` (keep the highest-CPU occurrence + mark ambiguous).
- Pure functions over (FusedModel, MethodBreakdown[]); no I/O. Byte-stable output (the determinism sort).
- A `FusionSummary` helper (reuse/extend P1's `formatFusionSummary`) for the headline counts.

### P2.1 — CLI output section
`src/output/sections.ts` + the formatters: add a new `AnalysisSectionType` `"fusion"`; implement its
renderer in EVERY `SectionRenderers<T>` impl (the type enforces this at compile time — terminal
[cli-table3], markdown, json, and any other formatter); place `"fusion"` in `SECTION_ORDER` (after
`hotspots`, before `patterns`). The section renders: (a) the hotspot annotations (the top-N hotspots with
their static cause inline — `[detector] title — rootCause @ file:line (fix: …, confidence: …)`; ambiguous
→ "N possible static causes (ambiguous)"; matched-clean → "analyzed, no static findings"; blind-spot →
"not statically analyzed (reason)"), and (b) the runtime-prioritized findings table (finding, detector,
the routine, totalTime%/selfTime%, severity). The section appears ONLY when fusion ran (the
`AnalysisResult` gains an OPTIONAL `fusion?: FusedModel` field, populated only when `fuseProfile`
succeeded; renderers emit nothing when it's absent → al-perf's existing output is byte-unchanged when
fusion is off). Wire `analyze.ts` to attach `result.fusion` (it already calls `fuseProfile` in P1 — P2
stores the model on the result instead of only printing the summary).

### P2.2 — MCP
`src/mcp/server.ts`: (a) augment `analyze_profile` — when a workspace `sourcePath` is available, include a
`fusion` block in the tool's structured output (the annotations + the prioritized findings + the
correlationSummary), gated so a profile-only call is unchanged; (b) add a dedicated `prioritized_findings`
tool (inputs: profilePath, sourcePath, top) returning the runtime-prioritized findings (the
"which static findings are actually hot" query — the highest-value LLM affordance). zod schemas + the
async handler pattern matching the existing tools; never-throw (degrade to profile-only + a note).

### P2.3 — web
`web/` (server.ts + handlers + public) + `src/cli/formatters/batch-html.ts`: render the fusion section in
the web analysis view — the hotspot annotations + the prioritized-findings table as HTML (reuse the
section renderer with an HTML `SectionRenderers<string>` impl if the web renders via the section system;
else a dedicated web handler/template). Gated on fusion being present. Match al-perf's existing web
styling (`web/public`).

## Data flow
`fuseProfile` (P1) → `FusedModel` → P2.0 `annotateHotspots`/`prioritizeFindings` → the view structs →
rendered by each surface (CLI section / MCP tool output / web template). The `AnalysisResult.fusion?`
optional field carries the model from `analyze.ts` to the renderers.

## Error handling / non-invasiveness
Fusion is OPT-IN (P1's `--no-fusion` + binary/workspace gating). When absent, `result.fusion` is
undefined → every renderer emits nothing for the `fusion` section → al-perf's existing CLI/MCP/web output
is byte-IDENTICAL. The MCP/web paths never throw on a fusion failure (P1's `fuseProfile` already returns
`{disabled}`; the surfaces handle it). The views are pure + deterministic (tested byte-stable).

## Testing (bun:test, al-perf conventions)
- P2.0: unit tests for `annotateHotspots`/`prioritizeFindings` over a hand-built (FusedModel,
  MethodBreakdown[]) — the ranking order (totalTime% desc + tiebreaks), the cold/blind/unkeyable
  unweighted bucket, the ambiguous flag carried through, de-dup, determinism. Reuse the ws-min fixture +
  its goldens for a realistic case.
- P2.1: the section renderer over each format (terminal/markdown/json) — the annotation lines + the
  prioritized table; AND a test asserting the section emits NOTHING (and the existing output is
  byte-unchanged) when `result.fusion` is undefined.
- P2.2: the MCP `prioritized_findings` tool + the augmented `analyze_profile` (fusion block present with a
  workspace, absent without); never-throw on a degraded engine.
- P2.3: the web handler/template renders the fusion (a rendering test); absent when fusion is off.
- al-perf's full `bun test` stays green; the whole P2 is additive + opt-in.

## Risks for the external review to stress
1. **Ranking metric correctness:** `totalTimePercent` — for a routine called from MANY sites, is the
   profile's `totalTimePercent` the aggregate across all calls (the right "impact"), or per-call? Verify
   against al-perf's `MethodBreakdown.totalTimePercent` semantics. A finding on a hot LEAF (high selfTime,
   low totalTime delta) vs a hot ORCHESTRATOR — does totalTime% mislead (the orchestrator's time is its
   callees')? The `selfTime%`/`gapTime` alongside mitigate; confirm the primary metric is defensible.
2. **The `SectionRenderers<T>` compile-time completeness:** adding `"fusion"` to `AnalysisSectionType`
   forces a renderer in EVERY formatter impl — enumerate them (terminal/markdown/json/html/MCP?) so none
   is missed; the empty-when-absent behavior per formatter.
3. **Honesty carried to the UX:** ambiguous → never "caused by X"; matched-clean → not "verified clean"
   if coverage was degraded (P1 already gates this); blind-spot reasons surfaced. The renderers must
   respect the P1 flags, not flatten them.
4. **`AnalysisResult.fusion?` additivity:** adding an optional field — does it leak into the existing
   JSON output (the `--format json` path serializes `result`)? It MUST be absent/undefined when fusion is
   off so existing JSON is byte-unchanged; when present it's an additive key (acceptable — a new optional
   field on an opt-in path). Verify the byte-unchanged-when-off guarantee holds for JSON too.
5. **De-dup + cold/unweighted:** a finding under multiple ambiguous keys (de-dup by fingerprint); cold
   findings surfaced as "not hot" not dropped; the prioritized list's stability.
6. **MCP/web non-throw + the structured-output shape** (the MCP fusion block schema; the web template).

## Non-goals (P2)
P3 (call-graph/effect drilldown via the StableRoutineId + `alsem fingerprint`/digest; the precise
field-trigger keying); P4 (regression fusion via `alsem diff`); changing al-perf's own `patterns.ts` or
`explain/` AI layer (the fusion is ADDITIVE — though P2 MAY reserve a slot to correlate al-sem findings
with al-perf's own patterns on the same routine, that cross-link is P3+).

## Self-review notes
- **P2.0 is the shared substrate** (pure views) all surfaces render — isolate it so the ranking/annotation
  logic is tested ONCE, independent of any renderer. P2.1/2.2/2.3 are thin presentation adapters over it.
- **Additivity is the spine:** the optional `result.fusion`, the gated section, the gated MCP/web blocks
  — al-perf's existing behavior is byte-unchanged when fusion is off (the P1 guarantee extended to P2).
- **Honesty propagates:** the P1 6-status + `attributionConfidence` + coverage-gated matched-clean are
  carried verbatim into every rendered view; no surface may upgrade "ambiguous"/"clean" claims.
- **Reuses** P1's FusedModel + `formatFusionSummary`; al-perf's section system, MCP tool pattern, web
  handlers — following each surface's established pattern, not restructuring.
