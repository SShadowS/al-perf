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

---

## Revision 2 — folded from the three-reviewer adversarial pass (2× opus + gemini-3.1-pro)

The original design above is superseded where it conflicts with this block. Three reviewers converged on
data-integrity and surface-mechanics holes that are corpus-invisible (they don't fail any current test).
Implement P2 to THIS revision.

### R2-1 — Carrier is derived view ARRAYS, never the raw FusedModel (MUST) [opus×2]
`FusedModel.attributions` is a `Map` → `JSON.stringify(result)` (the `--format json` path; MCP
`server.ts`; web `server.ts`) silently emits `"attributions": {}`, losing ALL fusion data. **Do NOT put
the raw `FusedModel` on `AnalysisResult`.** Instead `analyze.ts` attaches a derived, JSON-safe tree:
```ts
AnalysisResult.fusionViews?: {
  hotspotAnnotations: HotspotAnnotation[];   // P2.0 annotateHotspots output (plain arrays/objects)
  prioritizedFindings: PrioritizedFinding[]; // P2.0 prioritizeFindings output
  unweightedFindings: PrioritizedFinding[];  // cold/blind/unkeyable bucket (weight 0), kept separate
  correlationSummary: CorrelationSummary;    // already a plain object on FusedModel
}
```
Every field is plain arrays/objects — no `Map`, no `Set`. The raw `FusedModel` stays the P1 in-memory
sidecar inside `analyze.ts`; only `fusionViews` crosses to renderers/JSON/MCP/web. The optional field is
absent when fusion is off → existing JSON byte-unchanged (additivity preserved).

### R2-2 — `SectionRenderers<T>` has exactly 3 impls incl. html; html CANNOT be deferred (MUST) [opus-1]
The impls are `terminal.ts`, `markdown.ts`, `html.ts` — NOT json (json is plain `JSON.stringify`). Adding
`"fusion"` to `AnalysisSectionType` breaks `html.ts` compilation the instant the union changes. Therefore
**P2.1 ships the terminal + markdown + html renderers together** (the original "html is P2.3" split is
void). P2.3 (web) is the *client-side* `app.js` rendering — a separate concern from the server-side
`SectionRenderers<string>` html impl (see R2-6).

### R2-3 — Rank by `selfTimePercent` primary, not `totalTimePercent` (MUST) [opus-1, gemini]
`totalTimePercent` is INCLUSIVE (routine + callees), the per-method sum far exceeds 100%, and orchestrators
/roots dominate so a thin wrapper outranks the hot leaf it calls. **`prioritizeFindings` ranks by
`selfTimePercent` desc primary**, with `totalTimePercent` + `gapTime` shown alongside as secondary context.
Surface `efficiencyScore` (= selfTime/totalTime) on each row so a low score flags an orchestrator (its cost
is its callees', not its own code). Tiebreak: `(totalTimePercent desc, efficiencyScore desc,
finding.fingerprint, finding.id)`.

### R2-4 — Annotate hotspots IN PLACE; the new `"fusion"` section is prioritized-findings ONLY (MUST) [opus-2, gemini]
The original P2.1 (a) duplicated the hotspots table inside a new section. Instead:
- **View (a) annotations render IN PLACE**: extend the EXISTING `hotspots` renderer (in all 3
  `SectionRenderers` impls) to accept the side-map and render each hotspot's static cause inline,
  conditionally (nothing extra when `fusionViews` absent → hotspots output byte-unchanged when off).
- **The new `"fusion"` section carries ONLY view (b)**: the `PrioritizedFinding[]` inversion table. Placed
  in `SECTION_ORDER` after `hotspots`, before `patterns`.

### R2-5 — JSON additivity by a separate tree, NOT by mutating `result.hotspots[i]` (MUST) [gemini-S2]
Implementing R2-4's in-place annotation must NOT inject keys into the existing `result.hotspots[]` element
objects (that mutates al-perf's core JSON API schema for downstream consumers). The annotation join lives
ONLY in the renderer (terminal/markdown/html read `fusionViews.hotspotAnnotations` and correlate to the
hotspot row at render time). The JSON path emits `result.hotspots` strictly unchanged + the additive
`result.fusionViews` tree. `result.hotspots[i]` schema is invariant.

### R2-6 — Web is a hand-written `app.js` client renderer; P2.3 is bigger than the original spec (MUST) [opus-2, gemini]
`web/public/app.js` is a hand-written client-side JS renderer (`renderHotspots`/`renderPatterns`/…) that
mirrors `SECTION_ORDER` with NO TypeScript enforcement — a server-side section does NOT appear in the live
web UI automatically. P2.3 MUST: (a) add `renderFusion` (prioritized-findings table) + inline hotspot
annotation into `renderHotspots` in `app.js`; (b) add the markup/sidebar entry in `web/public/index.html`;
(c) ensure `web/server.ts` ships `fusionViews` in its JSON payload (depends on R2-1). `batch-html.ts` —
see R2-11.

### R2-7 — Truncation Libel: feed `fuseProfile` the UNTRUNCATED methods (MUST) [gemini]
`--top`/`--appFilter` truncate `result.hotspots` in `analyze.ts` BEFORE rendering. If the truncated array
reaches `fuseProfile`/`correlate`, every method below the UI cutoff is treated as zero-runtime → its valid
static findings are mislabeled `coldFindings` and its routines `coldRoutines`. That LIBELS hot executing
code as "not hot / no runtime sample." **`fuseProfile` MUST receive the full untruncated `MethodBreakdown[]`**
so `cold`/`orphan`/`matched` are computed against global runtime truth. Truncation (`top`/`appFilter`)
applies ONLY in `views.ts` when building the view arrays for display — and that display cap MUST be
`log()`/noted, never silent (a dropped hot finding must not read as "covered").

### R2-8 — Ambiguous de-dup SUMS CPU, does not keep-highest (MUST) [gemini]
P2.0's "keep the highest-CPU occurrence" UNDER-COUNTS: when `Field A - OnValidate` and `Field B - OnValidate`
are both hot they normalize to the same join key and map to the SAME finding; keeping only the max drops the
other's CPU. **A finding spanning N ambiguous method frames is ONE prioritized row whose `selfTimePercent`
and `totalTimePercent` are the SUM across those frames**, listing the multiple execution entry points. The
winning `method` reference shown is tiebroken by `method.functionName` string-compare for determinism.

### R2-9 — Render the honest `matched`-but-not-clean state (MUST) [gemini]
`correlate.ts` (≈ L351-363) emits `status: "matched"`, `findings: []`, `matchedClean: undefined`, with a
populated `reason` ("matched; coverage incomplete …") when a routine matched but its body was not fully
analyzed. The original renderer plan handled only `ambiguous`/`matched-clean`/`blind-spot` and would emit
confusing whitespace here. **Renderers (all surfaces) encountering `status === "matched" &&
findings.length === 0 && !matchedClean` MUST render the `reason` as a distinct "matched; coverage
incomplete" state** — never blank, never implied-clean. `annotateHotspots` carries `matchedClean` +
`reason` through verbatim (this is also R2-10's coverage-honesty requirement).

### R2-10 — `HotspotAnnotation` carries a coverage-degraded flag (MUST) [opus-2]
`matched-clean` must not read as "verified clean" when coverage was degraded. Coverage lives on
`FusedModel` (per-app), which a single annotation can't see. `annotateHotspots` MUST stamp each annotation
with the P1 honesty signals it needs locally — `matchedClean` (already gated in P1) PLUS the `reason`
string — so no renderer can upgrade an incomplete-coverage match to a clean claim. The matched-clean label
is shown ONLY when `matchedClean === true`.

### R2-11 — Out-of-scope, stated explicitly (MUST note) [opus-2, gemini]
- **Batch mode** (`batch-analyzer.ts`) never calls `fuseProfile` → `result.fusionViews` is absent → the
  batch SectionRenderers/`batch-html.ts` render nothing for fusion. This is intended; state it. Batch
  fusion is a later phase, not P2.
- The display cap from R2-7 is the ONLY truncation; never silently drop a hot finding.

### R2-12 — MCP must not blow the LLM context with cold findings (MUST) [gemini]
Legacy BC workspaces produce thousands of static findings. The `prioritized_findings` MCP tool and the
`analyze_profile` fusion block MUST return ONLY the runtime-weighted findings (`selfTimePercent > 0`), plus
the aggregate `correlationSummary` counts so the model knows what it isn't seeing. `unweightedFindings`
(cold/blind/unkeyable) are NOT inlined into MCP output — they're summarized by count only. (CLI/web MAY
show the unweighted bucket; MCP must not.)

### R2-13 — `corroboratingPatterns` cross-signal: leaf-only in P2, else false causality (MUST→SHOULD) [gemini, refines opus-2 M6]
Filling `corroboratingPatterns` from al-perf's own `patterns.ts` (M6) is high-value BUT unsound if matched
by method id alone: al-perf patterns trigger on INCLUSIVE behavior (a heavy orchestrator's whole subtree),
while al-sem findings are LEXICAL line items — intersecting them on a shared `MethodBreakdown` falsely
"runtime-confirms" an unrelated finding (an N+1 deep in the call graph corroborating a top-of-orchestrator
static line). **P2 cross-signal corroboration is limited to LEAF routines (`efficiencyScore > 0.8`)** where
inclusive ≈ exclusive; broader call-graph-aware corroboration waits for P3. If leaf-gating proves too thin
to be useful, DEFER `corroboratingPatterns` entirely to P3 rather than ship false causality.

### R2-14 — Determinism beyond Map iteration (MUST) [opus-2, gemini]
`prioritizeFindings`/`annotateHotspots` drive off the ORDERED `methods[]` array, never `Map` iteration
order. All sorts have a total tiebreak chain ending in `finding.id` (unique) so output is byte-stable.
Ambiguous-frame winner selection (R2-8) and any "representative method" pick use `functionName`
string-compare as the final tiebreak. Add a byte-stability test (run twice, assert identical) per view.

### R2 testing additions
- A test feeding `fuseProfile` a method array then truncating in `views.ts` — assert a below-cutoff method
  with findings is NOT labeled cold (R2-7).
- A test: two hot ambiguous frames + one shared finding → one row, summed CPU (R2-8).
- A test: matched, zero findings, degraded coverage → renders the "coverage incomplete" state, never blank
  and never "clean" (R2-9/R2-10), across terminal/markdown/html.
- A test: `result.fusionViews` absent → terminal/markdown/html/json output byte-identical to pre-P2; and
  `result.hotspots[i]` schema unchanged when fusion IS on (R2-1/R2-5).
- A test: MCP output excludes cold/orphan findings, includes the summary counts (R2-12).
- Byte-stability (run-twice-identical) for both views (R2-14).
