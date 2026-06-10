# Phase P2: Fusion UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the P1 `FusedModel` into two JSON-safe derived views (hotspot static-cause annotations + runtime-prioritized findings) and render them across every al-perf surface (CLI sections, MCP, web), additively and opt-in.

**Architecture:** A single pure view layer (`src/semantic/views.ts`) converts `FusedModel` + the full `MethodBreakdown[]` into plain arrays. `analyze.ts` attaches those arrays as an optional `AnalysisResult.fusionViews` tree (never the raw `Map`-bearing `FusedModel`). Renderers read `fusionViews`: hotspot annotations render IN PLACE inside the existing `hotspots` renderer; the prioritized findings get a NEW `"fusion"` section. When `fusionViews` is absent, every surface is byte-identical to pre-P2.

**Tech Stack:** TypeScript, Bun (`bun test`), Biome, zod (MCP), hand-written web client JS.

**Governing spec:** `docs/superpowers/specs/2026-06-10-phase-p2-fusion-ux-design.md` — implement to **Revision 2** (R2-1 … R2-14). Every task below cites the Revision-2 clauses it satisfies.

**Branch:** all work on `feat/alsem-fusion` (already checked out). Do NOT push.

**Commands:** `bun test <file>` (single), `bun test` (all), `bun run typecheck`, `bun run format` BEFORE `bun run lint`.

---

## File Structure

- **Create** `src/semantic/views.ts` — pure view layer: `HotspotAnnotation`, `PrioritizedFinding` types + `annotateHotspots`, `prioritizeFindings`. One responsibility: derive JSON-safe views from `FusedModel`.
- **Modify** `src/semantic/correlate.ts` — export `methodAttrKey` (currently private at line 80) so `views.ts` joins on the identical key. DRY.
- **Modify** `src/output/types.ts` — add optional `fusionViews?: FusionViews` to `AnalysisResult`.
- **Modify** `src/core/analyzer.ts` — add `onAllMethods?` callback to `AnalyzeOptions`, invoked with the full non-idle `MethodBreakdown[]` (untruncated) — R2-7.
- **Modify** `src/cli/commands/analyze.ts` — capture all methods, build `fusionViews` via `views.ts`, attach to `result`.
- **Modify** `src/output/sections.ts` — add `"fusion"` to `AnalysisSectionType` + `SECTION_ORDER` (after `hotspots`, before `patterns`).
- **Modify** `src/cli/formatters/terminal.ts`, `markdown.ts`, `html.ts` — add the `fusion` renderer + in-place hotspot annotation (R2-2, R2-4, R2-5).
- **Modify** `src/mcp/server.ts` — augment `analyze_profile`, add `prioritized_findings` tool, drop cold findings (R2-12).
- **Modify** `web/server.ts` (payload already serializes `result`), `web/public/app.js` (renderFusion + annotate renderHotspots), `web/public/index.html` (section div + sidebar entry) — R2-6.
- **Test** `test/semantic/views.test.ts`, additions to `test/cli/formatters/*.test.ts`, `test/mcp/server.test.ts`, `test/web/server.test.ts`.

**Type shapes (defined once in `views.ts`, reused everywhere):**

```typescript
import type { FindingSummary } from "./contracts.js";
import type { CorrelationStatus, AttributionConfidence, CorrelationSummary } from "../types/fused.js";
import type { MethodBreakdown } from "../types/aggregated.js";

/** One runtime hotspot joined to its static attribution (rendered in place in the hotspots table). */
export interface HotspotAnnotation {
  /** Join key = `${functionName}_${objectType}_${objectId}` — identical to correlate's methodAttrKey. */
  attrKey: string;
  status: CorrelationStatus;            // "matched" | "ambiguous" | "blind-spot"
  attributionConfidence: AttributionConfidence;
  findings: FindingSummary[];
  matchedClean?: boolean;               // true ONLY when verified clean under full coverage (R2-10)
  reason?: string;                      // honest "coverage incomplete" / blind-spot reason (R2-9, R2-10)
  stableRoutineId?: string | string[];
  corroboratingPatterns?: string[];     // R2-13, leaf-only
}

/** A static finding weighted by the runtime cost of the routine(s) it sits on. */
export interface PrioritizedFinding {
  finding: FindingSummary;
  /** Representative method (highest self-time frame; tiebroken by functionName). */
  functionName: string;
  objectType: string;
  objectId: number;
  appName: string;
  /** SUM across all ambiguous frames sharing this finding (R2-8). */
  selfTimePercent: number;
  totalTimePercent: number;
  gapTime?: number;
  efficiencyScore: number;              // representative frame's selfTime/totalTime (R2-3 orchestrator flag)
  /** Number of distinct hot method frames this finding spans (>1 ⇒ ambiguous). */
  frameCount: number;
  status: CorrelationStatus;
  attributionConfidence: AttributionConfidence;
}

/** JSON-safe carrier on AnalysisResult — NO Map/Set (R2-1). */
export interface FusionViews {
  hotspotAnnotations: HotspotAnnotation[];
  prioritizedFindings: PrioritizedFinding[];   // selfTime > 0, ranked
  unweightedFindings: PrioritizedFinding[];     // cold/blind/unkeyable, weight 0 (R2-12 CLI/web only)
  correlationSummary: CorrelationSummary;
}
```

---

## Task 0: Export `methodAttrKey` from correlate

**Files:**
- Modify: `src/semantic/correlate.ts:80`

- [ ] **Step 1: Export the key helper**

In `src/semantic/correlate.ts`, change the private function at line 80 from `function methodAttrKey(` to `export function methodAttrKey(`. No other change.

```typescript
export function methodAttrKey(m: MethodBreakdown): string {
	return `${m.functionName}_${m.objectType}_${m.objectId}`;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add src/semantic/correlate.ts
git commit -m "refactor(semantic): export methodAttrKey for the view layer"
```

---

## Task 1: The pure view layer (`src/semantic/views.ts`) — P2.0

**Files:**
- Create: `src/semantic/views.ts`
- Test: `test/semantic/views.test.ts`

Satisfies R2-1 (JSON-safe arrays), R2-3 (selfTime ranking), R2-8 (ambiguous CPU sum), R2-9/R2-10 (honesty fields), R2-12 (unweighted split), R2-13 (leaf-only corroboration), R2-14 (determinism off ordered methods).

- [ ] **Step 1: Write failing tests**

Create `test/semantic/views.test.ts`. Reuse the factory pattern from `test/semantic/correlate.test.ts` (`makeMethod`, `makeFinding`, build an `EngineAnalysis`, run `correlate`, then call the views). Copy `makeMethod`/`makeFinding`/`makeRoutine` from that file.

```typescript
import { describe, expect, it } from "bun:test";
import { correlate } from "../../src/semantic/correlate.js";
import { annotateHotspots, prioritizeFindings } from "../../src/semantic/views.js";
import type { EngineAnalysis } from "../../src/semantic/engine-runner.js";
import type { MethodBreakdown } from "../../src/types/aggregated.js";
import type { FindingSummary, RoutineIdentity } from "../../src/semantic/contracts.js";

const APP_GUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function makeRoutine(routineName: string, objectNumber: number, objectType: string, stableRoutineId: string): RoutineIdentity {
	return { stableRoutineId, objectType, objectNumber, routineName };
}
function makeFinding(id: string, fingerprint: string, detector: string, routineName: string | undefined, objectType: string, objectNumber: number): FindingSummary {
	return {
		id, fingerprint, detector, title: `Finding ${id}`, rootCause: "test",
		severity: "high", confidence: { level: "likely" },
		primaryLocation: { file: "ws:src/Test.al", line: 10, column: 1, objectId: `${APP_GUID}/${objectType}/${objectNumber}`, objectName: "TestObject", routineName },
		affectedObjects: [`${APP_GUID}/${objectType}/${objectNumber}`], affectedTables: [],
	};
}
function makeMethod(functionName: string, objectType: string, objectId: number, selfTimePercent: number, totalTimePercent: number, opts?: Partial<MethodBreakdown>): MethodBreakdown {
	return {
		functionName, objectType, objectName: "TestObject", objectId, appName: "FusionMinimal",
		selfTime: selfTimePercent * 10, selfTimePercent, totalTime: totalTimePercent * 10, totalTimePercent,
		hitCount: 5, calledBy: [], calls: [], costPerHit: 100,
		efficiencyScore: totalTimePercent > 0 ? selfTimePercent / totalTimePercent : 1, ...opts,
	};
}

describe("prioritizeFindings", () => {
	it("ranks by selfTimePercent desc, not totalTimePercent (R2-3)", () => {
		// leaf: high self, low total. orchestrator: low self, high total.
		const methods = [
			makeMethod("Orchestrator", "Codeunit", 50000, 5, 90),
			makeMethod("HotLeaf", "Codeunit", 50001, 80, 80),
		];
		const engine: EngineAnalysis = {
			appGuid: APP_GUID,
			routines: [makeRoutine("Orchestrator", 50000, "Codeunit", "r0"), makeRoutine("HotLeaf", 50001, "Codeunit", "r1")],
			findings: [
				makeFinding("FO", "fpO", "d1", "Orchestrator", "Codeunit", 50000),
				makeFinding("FL", "fpL", "d1", "HotLeaf", "Codeunit", 50001),
			],
			coverage: [],
		};
		const fused = correlate(methods, engine);
		const ranked = prioritizeFindings(fused, methods);
		expect(ranked[0].finding.id).toBe("FL"); // hot leaf outranks orchestrator
		expect(ranked[0].efficiencyScore).toBeGreaterThan(ranked[1].efficiencyScore);
	});

	it("sums CPU across ambiguous frames sharing one finding (R2-8)", () => {
		// Two field triggers normalize to one key/finding; selfTime must SUM.
		const methods = [
			makeMethod("Field A - OnValidate", "Table", 50100, 10, 10),
			makeMethod("Field B - OnValidate", "Table", 50100, 8, 8),
		];
		const engine: EngineAnalysis = {
			appGuid: APP_GUID,
			routines: [makeRoutine("OnValidate", 50100, "Table", "rt")],
			findings: [makeFinding("FT", "fpT", "d1", "OnValidate", "Table", 50100)],
			coverage: [],
		};
		const fused = correlate(methods, engine);
		const ranked = prioritizeFindings(fused, methods);
		const ft = ranked.find((r) => r.finding.id === "FT");
		expect(ft?.selfTimePercent).toBe(18); // 10 + 8 summed, not max(10)
		expect(ft?.frameCount).toBe(2);
	});

	it("puts cold/blind/unkeyable findings in unweighted, never weighted (R2-12)", () => {
		const methods = [makeMethod("Hot", "Codeunit", 50000, 50, 50)];
		const engine: EngineAnalysis = {
			appGuid: APP_GUID,
			routines: [makeRoutine("Hot", 50000, "Codeunit", "r0"), makeRoutine("ColdRoutine", 50002, "Codeunit", "r2")],
			findings: [
				makeFinding("FH", "fpH", "d1", "Hot", "Codeunit", 50000),
				makeFinding("FC", "fpC", "d1", "ColdRoutine", "Codeunit", 50002), // not in methods → cold
			],
			coverage: [],
		};
		const fused = correlate(methods, engine);
		const ranked = prioritizeFindings(fused, methods);
		expect(ranked.map((r) => r.finding.id)).toEqual(["FH"]);
		expect(ranked.every((r) => r.selfTimePercent > 0)).toBe(true);
	});

	it("is byte-stable across two runs (R2-14)", () => {
		const methods = [makeMethod("A", "Codeunit", 1, 10, 10), makeMethod("B", "Codeunit", 2, 10, 10)];
		const engine: EngineAnalysis = {
			appGuid: APP_GUID,
			routines: [makeRoutine("A", 1, "Codeunit", "ra"), makeRoutine("B", 2, "Codeunit", "rb")],
			findings: [makeFinding("FA", "fpA", "d1", "A", "Codeunit", 1), makeFinding("FB", "fpB", "d1", "B", "Codeunit", 2)],
			coverage: [],
		};
		const f1 = correlate(methods, engine);
		const f2 = correlate(methods, engine);
		expect(JSON.stringify(prioritizeFindings(f1, methods))).toBe(JSON.stringify(prioritizeFindings(f2, methods)));
	});
});

describe("annotateHotspots", () => {
	it("carries matched-clean + reason verbatim, never upgrades a degraded match (R2-9/R2-10)", () => {
		const methods = [makeMethod("Clean", "Codeunit", 50000, 30, 30)];
		const engine: EngineAnalysis = {
			appGuid: APP_GUID,
			routines: [makeRoutine("Clean", 50000, "Codeunit", "r0")],
			findings: [], // no findings
			coverage: [], // empty coverage → not fully analyzed → matchedClean undefined + reason set
		};
		const fused = correlate(methods, engine);
		const ann = annotateHotspots(fused, methods);
		expect(ann).toHaveLength(1);
		expect(ann[0].status).toBe("matched");
		expect(ann[0].matchedClean).toBeUndefined();
		expect(ann[0].reason).toContain("coverage incomplete");
	});

	it("preserves the methods[] order (R2-14)", () => {
		const methods = [makeMethod("First", "Codeunit", 1, 50, 50), makeMethod("Second", "Codeunit", 2, 40, 40)];
		const engine: EngineAnalysis = {
			appGuid: APP_GUID,
			routines: [makeRoutine("First", 1, "Codeunit", "r1"), makeRoutine("Second", 2, "Codeunit", "r2")],
			findings: [], coverage: [],
		};
		const ann = annotateHotspots(correlate(methods, engine), methods);
		expect(ann.map((a) => a.attrKey)).toEqual(["First_Codeunit_1", "Second_Codeunit_2"]);
	});
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test test/semantic/views.test.ts`
Expected: FAIL — `views.js` does not exist / functions undefined.

- [ ] **Step 3: Implement `src/semantic/views.ts`**

```typescript
import type { MethodBreakdown } from "../types/aggregated.js";
import type {
	AttributionConfidence,
	CorrelationStatus,
	CorrelationSummary,
	FusedModel,
} from "../types/fused.js";
import type { FindingSummary } from "./contracts.js";
import { methodAttrKey } from "./correlate.js";

export interface HotspotAnnotation {
	attrKey: string;
	status: CorrelationStatus;
	attributionConfidence: AttributionConfidence;
	findings: FindingSummary[];
	matchedClean?: boolean;
	reason?: string;
	stableRoutineId?: string | string[];
	corroboratingPatterns?: string[];
}

export interface PrioritizedFinding {
	finding: FindingSummary;
	functionName: string;
	objectType: string;
	objectId: number;
	appName: string;
	selfTimePercent: number;
	totalTimePercent: number;
	gapTime?: number;
	efficiencyScore: number;
	frameCount: number;
	status: CorrelationStatus;
	attributionConfidence: AttributionConfidence;
}

export interface FusionViews {
	hotspotAnnotations: HotspotAnnotation[];
	prioritizedFindings: PrioritizedFinding[];
	unweightedFindings: PrioritizedFinding[];
	correlationSummary: CorrelationSummary;
}

/**
 * One annotation per AL hotspot, in the SAME order as `methods` (R2-14). Carries
 * the P1 honesty signals verbatim — matchedClean is shown true ONLY when the P1
 * gate set it true; `reason` surfaces "coverage incomplete"/blind-spot (R2-9/R2-10).
 * Methods with no attribution (non-AL frames the join skipped) are omitted.
 */
export function annotateHotspots(
	fused: FusedModel,
	methods: MethodBreakdown[],
): HotspotAnnotation[] {
	const out: HotspotAnnotation[] = [];
	for (const m of methods) {
		const key = methodAttrKey(m);
		const attr = fused.attributions.get(key);
		if (!attr) continue; // non-AL / unjoined frame → no annotation
		out.push({
			attrKey: key,
			status: attr.status,
			attributionConfidence: attr.attributionConfidence,
			findings: attr.findings,
			matchedClean: attr.matchedClean,
			reason: attr.reason,
			stableRoutineId: attr.stableRoutineId,
			corroboratingPatterns: attr.corroboratingPatterns,
		});
	}
	return out;
}

/**
 * Static findings weighted by runtime cost. Ranked by selfTimePercent desc (R2-3:
 * totalTime is inclusive/orchestrator-skewed). A finding spanning N ambiguous hot
 * frames is ONE row whose CPU is the SUM across frames (R2-8). Findings on
 * cold/blind/unkeyable routines have no runtime sample → `unweightedFindings`,
 * never weighted/dropped (R2-12). Drives off the ordered `methods[]` for
 * determinism (R2-14).
 */
export function prioritizeFindings(
	fused: FusedModel,
	methods: MethodBreakdown[],
): { weighted: PrioritizedFinding[]; unweighted: PrioritizedFinding[] } {
	// Accumulate per-finding across all hot frames that carry it.
	interface Acc {
		finding: FindingSummary;
		selfTimePercent: number;
		totalTimePercent: number;
		gapTime: number;
		frameCount: number;
		status: CorrelationStatus;
		attributionConfidence: AttributionConfidence;
		// representative frame (max selfTime; tiebreak functionName)
		rep: MethodBreakdown;
	}
	const acc = new Map<string, Acc>(); // keyed by finding.fingerprint

	for (const m of methods) {
		const attr = fused.attributions.get(methodAttrKey(m));
		if (!attr || attr.findings.length === 0) continue;
		for (const finding of attr.findings) {
			const existing = acc.get(finding.fingerprint);
			if (!existing) {
				acc.set(finding.fingerprint, {
					finding,
					selfTimePercent: m.selfTimePercent,
					totalTimePercent: m.totalTimePercent,
					gapTime: m.gapTime ?? 0,
					frameCount: 1,
					status: attr.status,
					attributionConfidence: attr.attributionConfidence,
					rep: m,
				});
			} else {
				existing.selfTimePercent += m.selfTimePercent; // SUM (R2-8)
				existing.totalTimePercent += m.totalTimePercent;
				existing.gapTime += m.gapTime ?? 0;
				existing.frameCount += 1;
				// representative = highest self-time frame; tiebreak by functionName
				if (
					m.selfTimePercent > existing.rep.selfTimePercent ||
					(m.selfTimePercent === existing.rep.selfTimePercent &&
						m.functionName < existing.rep.functionName)
				) {
					existing.rep = m;
				}
			}
		}
	}

	const toPrioritized = (a: Acc): PrioritizedFinding => ({
		finding: a.finding,
		functionName: a.rep.functionName,
		objectType: a.rep.objectType,
		objectId: a.rep.objectId,
		appName: a.rep.appName,
		selfTimePercent: a.selfTimePercent,
		totalTimePercent: a.totalTimePercent,
		gapTime: a.gapTime > 0 ? a.gapTime : undefined,
		efficiencyScore: a.rep.efficiencyScore,
		frameCount: a.frameCount,
		status: a.status,
		attributionConfidence: a.attributionConfidence,
	});

	const weighted = [...acc.values()].map(toPrioritized).sort(cmpPrioritized);

	// Unweighted bucket: cold + orphan + unkeyable findings (no runtime sample).
	const unweighted: PrioritizedFinding[] = [
		...fused.coldFindings,
		...fused.orphanFindings,
		...fused.unkeyableFindings,
	]
		.map((finding) => ({
			finding,
			functionName: finding.primaryLocation.routineName ?? "",
			objectType: "",
			objectId: 0,
			appName: "",
			selfTimePercent: 0,
			totalTimePercent: 0,
			gapTime: undefined,
			efficiencyScore: 0,
			frameCount: 0,
			status: "blind-spot" as CorrelationStatus,
			attributionConfidence: "exact" as AttributionConfidence,
		}))
		.sort((x, y) =>
			x.finding.fingerprint < y.finding.fingerprint
				? -1
				: x.finding.fingerprint > y.finding.fingerprint
					? 1
					: x.finding.id < y.finding.id
						? -1
						: x.finding.id > y.finding.id
							? 1
							: 0,
		);

	return { weighted, unweighted };
}

/** Total ordering: selfTime desc, totalTime desc, efficiency desc, fingerprint, id (R2-3/R2-14). */
function cmpPrioritized(a: PrioritizedFinding, b: PrioritizedFinding): number {
	if (b.selfTimePercent !== a.selfTimePercent)
		return b.selfTimePercent - a.selfTimePercent;
	if (b.totalTimePercent !== a.totalTimePercent)
		return b.totalTimePercent - a.totalTimePercent;
	if (b.efficiencyScore !== a.efficiencyScore)
		return b.efficiencyScore - a.efficiencyScore;
	if (a.finding.fingerprint !== b.finding.fingerprint)
		return a.finding.fingerprint < b.finding.fingerprint ? -1 : 1;
	return a.finding.id < b.finding.id ? -1 : a.finding.id > b.finding.id ? 1 : 0;
}
```

**NOTE for implementer:** the test calls `prioritizeFindings(...)` and indexes the result as an array (`ranked[0]`). Reconcile: change the tests to destructure `const { weighted } = prioritizeFindings(...)` and assert on `weighted`, OR keep the function returning `{weighted, unweighted}` and update the test accordingly. The `{weighted, unweighted}` shape is correct (the caller in Task 2 needs both) — **update the test assertions to destructure**. Do this in Step 1 before running.

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test test/semantic/views.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Format, lint, typecheck**

```bash
bun run format && bun run lint && bun run typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/semantic/views.ts test/semantic/views.test.ts
git commit -m "feat(p2.0): pure fusion view layer — annotateHotspots + prioritizeFindings"
```

---

## Task 2: Wire `fusionViews` onto AnalysisResult — P2.0 wiring

**Files:**
- Modify: `src/output/types.ts` (AnalysisResult)
- Modify: `src/core/analyzer.ts` (onAllMethods callback)
- Modify: `src/cli/commands/analyze.ts` (build + attach fusionViews)
- Test: `test/cli/commands/analyze.fusion.test.ts` (new) or extend an existing analyze test

Satisfies R2-1 (carrier), R2-7 (untruncated methods), R2-11 (display cap noted).

- [ ] **Step 1: Add the optional field to AnalysisResult**

In `src/output/types.ts`, import the view type and add the optional field after `aiNarrative?`:

```typescript
import type { FusionViews } from "../semantic/views.js";
// ... inside interface AnalysisResult, after aiNarrative?: string;
	/** Present ONLY when al-sem fusion ran (opt-in). Absent ⇒ output byte-unchanged. */
	fusionViews?: FusionViews;
```

- [ ] **Step 2: Add the untruncated-methods callback to the analyzer**

In `src/core/analyzer.ts`, add to `AnalyzeOptions` (near `onProcessedProfile`, line ~39):

```typescript
	/** Callback to access the full non-idle method list (untruncated) for fusion (R2-7). */
	onAllMethods?: (methods: MethodBreakdown[]) => void;
```

Then invoke it right after `nonIdleMethods` is computed (line ~257). Move/duplicate so the callback fires with the global non-idle set BEFORE any top/appFilter view-truncation matters:

```typescript
	const nonIdleMethods = methods.filter((m) => !isIdle(m));
	options?.onAllMethods?.(nonIdleMethods);
```

(`MethodBreakdown` is already imported in analyzer.ts; if not, add the type import.)

- [ ] **Step 3: Build and attach `fusionViews` in analyze.ts**

In `src/cli/commands/analyze.ts`, capture all methods and replace the P1 summary-only block (lines ~238-261). Add the capture in the `analyzeProfile` options, then build views from the FusedModel:

```typescript
import { annotateHotspots, prioritizeFindings } from "../../semantic/views.js";
// ... in the analyzeProfile options object (alongside onProcessedProfile):
		let allMethods: MethodBreakdown[] = [];
		// onAllMethods: (m) => { allMethods = m; },   // add this line into the options literal
```

Then the fusion block becomes (R2-7: pass `allMethods`, NOT `result.hotspots`):

```typescript
if (fusionWorkspace) {
	try {
		const fuseResult = await fuseProfile(allMethods, fusionWorkspace);
		if ("disabled" in fuseResult) {
			process.stderr.write(`al-sem fusion: disabled (${fuseResult.reason})\n`);
		} else {
			const { weighted, unweighted } = prioritizeFindings(fuseResult, allMethods);
			result.fusionViews = {
				hotspotAnnotations: annotateHotspots(fuseResult, allMethods),
				prioritizedFindings: weighted,
				unweightedFindings: unweighted,
				correlationSummary: fuseResult.correlationSummary,
			};
			process.stderr.write(`${formatFusionSummary(fuseResult)}\n`);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`al-sem fusion: unexpected error: ${msg}\n`);
	}
}
```

**Note (R2-11):** the renderers (Task 3) apply the `top`/`appFilter` display cap to `fusionViews.prioritizedFindings`; the model here is global/untruncated.

- [ ] **Step 4: Write the wiring test**

Create `test/cli/commands/analyze.fusion.test.ts` — assert that, given a profile + AL workspace fixture where the engine is unavailable (`alsem` not found), `result.fusionViews` stays `undefined` and the rest is unchanged; and given a stubbed FusedModel path, the views attach. Reuse the existing analyze fixtures. (If invoking the real engine in-test is impractical, assert the narrower contract: when fusion is off `result.fusionViews === undefined`.) Minimum assertion:

```typescript
import { describe, expect, test } from "bun:test";
import { analyzeProfile } from "../../../src/core/analyzer.js";

describe("analyze fusion wiring", () => {
	test("fusionViews is undefined when fusion does not run", async () => {
		const result = await analyzeProfile("test/fixtures/sampling-minimal.alcpuprofile");
		expect(result.fusionViews).toBeUndefined();
	});
	test("onAllMethods receives the full non-idle method set", async () => {
		let count = -1;
		await analyzeProfile("test/fixtures/sampling-minimal.alcpuprofile", {
			top: 1,
			onAllMethods: (m) => { count = m.length; },
		});
		expect(count).toBeGreaterThanOrEqual(1); // untruncated by top:1
	});
});
```

- [ ] **Step 5: Run, format, lint, typecheck**

```bash
bun test test/cli/commands/analyze.fusion.test.ts
bun run format && bun run lint && bun run typecheck
```
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/output/types.ts src/core/analyzer.ts src/cli/commands/analyze.ts test/cli/commands/analyze.fusion.test.ts
git commit -m "feat(p2.0): attach fusionViews to AnalysisResult from untruncated methods"
```

---

## Task 3: CLI section renderers — P2.1

**Files:**
- Modify: `src/output/sections.ts`
- Modify: `src/cli/formatters/terminal.ts`, `src/cli/formatters/markdown.ts`, `src/cli/formatters/html.ts`
- Test: extend `test/cli/formatters/terminal.test.ts`, `markdown.test.ts`, `html.test.ts`

Satisfies R2-2 (3 impls incl html, no defer), R2-4 (annotate in place + fusion section = prioritized only), R2-5 (no hotspots[i] mutation), R2-9/R2-10 (honest states).

- [ ] **Step 1: Add the section type**

In `src/output/sections.ts`: add `| "fusion"` to `AnalysisSectionType`, and insert `"fusion"` in `SECTION_ORDER` between `"hotspots"` and `"patterns"`:

```typescript
export type AnalysisSectionType =
	| "summary"
	| "hotspots"
	| "fusion"
	| "criticalPath"
	// ...rest unchanged
```
```typescript
export const SECTION_ORDER: readonly AnalysisSectionType[] = [
	"summary", "explanation", "appBreakdown", "tableBreakdown",
	"hotspots", "fusion", "criticalPath", "patterns",
	"objectBreakdown", "aiNarrative", "aiFindings",
] as const;
```

- [ ] **Step 2: Run typecheck — confirm all 3 impls now fail to compile (R2-2 proof)**

Run: `bun run typecheck`
Expected: FAIL — `terminal.ts`, `markdown.ts`, `html.ts` each miss the `fusion` key in their `SectionRenderers<string>` literal. (This is the compile-time completeness guarantee; html cannot be deferred.)

- [ ] **Step 3: Implement the terminal renderer + in-place annotation**

In `src/cli/formatters/terminal.ts`:

(a) **Annotate hotspots in place** — extend `renderHotspots` (R2-4, R2-5: read `result.fusionViews`, do NOT mutate `result.hotspots`). After the existing table push loop, when `result.fusionViews` is present, append a cause line under each hotspot. Build a lookup once:

```typescript
function fusionAnnotationLine(result: AnalysisResult, h: MethodBreakdown): string {
	const fv = result.fusionViews;
	if (!fv) return "";
	const key = `${h.functionName}_${h.objectType}_${h.objectId}`;
	const a = fv.hotspotAnnotations.find((x) => x.attrKey === key);
	if (!a) return "";
	if (a.status === "blind-spot")
		return chalk.gray(`    ↳ not statically analyzed${a.reason ? ` (${a.reason})` : ""}`);
	if (a.status === "ambiguous")
		return chalk.yellow(`    ↳ ${a.findings.length} possible static cause(s) (ambiguous)`);
	// matched
	if (a.findings.length === 0)
		return a.matchedClean
			? chalk.green("    ↳ analyzed, no static findings")
			: chalk.gray(`    ↳ matched; ${a.reason ?? "coverage incomplete"}`); // R2-9
	return a.findings
		.map((f) =>
			chalk.cyan(
				`    ↳ [${f.detector}] ${f.title} @ ${f.primaryLocation.file}:${f.primaryLocation.line}` +
					` (${f.severity}/${f.confidence.level})`,
			),
		)
		.join("\n");
}
```

Append the line into the table rows (cli-table3 supports a following plain-text block; simplest: after `lines.push(hotspotsTable.toString())`, when fusion present, emit a per-hotspot annotation list below the table — keep it readable). Implementer chooses placement but MUST: render nothing when `result.fusionViews` is undefined (byte-unchanged), and never claim "clean" unless `matchedClean === true`.

(b) **The new `fusion` section** (prioritized findings ONLY — R2-4):

```typescript
function renderFusion(result: AnalysisResult): string {
	const fv = result.fusionViews;
	if (!fv || fv.prioritizedFindings.length === 0) return "";
	const lines: string[] = [chalk.bold("Runtime-Prioritized Static Findings")];
	const table = new Table({
		head: ["#", "Finding", "Detector", "Routine", "Self%", "Total%", "Sev"].map((h) => chalk.gray(h)),
		style: { head: [], border: [] },
	});
	fv.prioritizedFindings.forEach((p, i) => {
		const orch = p.efficiencyScore < 0.5 ? chalk.gray(" (orchestrator)") : "";
		const amb = p.frameCount > 1 ? chalk.yellow(` (×${p.frameCount} ambiguous)`) : "";
		table.push([
			String(i + 1),
			chalk.white(p.finding.title) + amb,
			p.finding.detector,
			`${p.functionName}${orch}`,
			p.selfTimePercent.toFixed(1),
			p.totalTimePercent.toFixed(1),
			p.finding.severity,
		]);
	});
	lines.push(table.toString());
	return lines.join("\n");
}
```

Add `fusion: renderFusion,` to the `terminalSections` literal.

- [ ] **Step 4: Implement the markdown renderer + annotation**

Mirror Step 3 in `src/cli/formatters/markdown.ts`: a `renderFusion` producing a `## Runtime-Prioritized Static Findings` table (same columns), and an inline annotation appended to each hotspot row's "Called By" cell or as a sub-row. Render nothing when `fusionViews` absent. Add `fusion: renderFusion,` to `markdownSections`.

```typescript
function renderFusion(result: AnalysisResult): string {
	const fv = result.fusionViews;
	if (!fv || fv.prioritizedFindings.length === 0) return "";
	const lines = ["## Runtime-Prioritized Static Findings", "",
		"| # | Finding | Detector | Routine | Self% | Total% | Severity |",
		"| --- | --- | --- | --- | --- | --- | --- |"];
	fv.prioritizedFindings.forEach((p, i) => {
		const amb = p.frameCount > 1 ? ` (×${p.frameCount})` : "";
		lines.push(`| ${i + 1} | ${p.finding.title}${amb} | ${p.finding.detector} | ${p.functionName} | ${p.selfTimePercent.toFixed(1)} | ${p.totalTimePercent.toFixed(1)} | ${p.finding.severity} |`);
	});
	return lines.join("\n");
}
```

For the in-place markdown annotation, append a finding indicator into the hotspots table — simplest: add a trailing line list after the table (a `> ` blockquote per annotated hotspot), gated on `result.fusionViews`.

- [ ] **Step 5: Implement the html renderer + annotation**

Mirror in `src/cli/formatters/html.ts`: a `renderFusion` returning a `<div class="section"><h2>Runtime-Prioritized Static Findings</h2><table>…</table></div>` (escape all finding text via the existing `escapeHtml`), and an inline annotation row appended to each hotspot `<tr>` (or a `<tr class="fusion-annotation"><td colspan="8">…</td></tr>` after each). Render `""` when `fusionViews` absent. Add `fusion: renderFusion,` to `htmlSections`.

- [ ] **Step 6: Write the renderer tests (all 3 formats)**

Extend each `test/cli/formatters/*.test.ts`. Build an `AnalysisResult` via `analyzeProfile`, then attach a hand-made `result.fusionViews`:

```typescript
test("fusion section renders prioritized findings", async () => {
	const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
	result.fusionViews = {
		hotspotAnnotations: [],
		prioritizedFindings: [{
			finding: { id: "F1", fingerprint: "fp1", detector: "n-plus-one", title: "N+1 query",
				rootCause: "loop", severity: "high", confidence: { level: "likely" },
				primaryLocation: { file: "src/X.al", line: 5, column: 1, objectId: "g/Codeunit/1", objectName: "X" },
				affectedObjects: [], affectedTables: [] },
			functionName: "ProcessLine", objectType: "Codeunit", objectId: 1, appName: "App",
			selfTimePercent: 42, totalTimePercent: 50, efficiencyScore: 0.84, frameCount: 1,
			status: "matched", attributionConfidence: "exact",
		}],
		unweightedFindings: [],
		correlationSummary: { matched: 1, matchedClean: 0, ambiguous: 0, blindSpot: 0, coldCount: 0, unkeyableCount: 0, orphanCount: 0 },
	};
	const out = formatAnalysisTerminal(result); // or markdown/html
	expect(out).toContain("Runtime-Prioritized Static Findings");
	expect(out).toContain("N+1 query");
});

test("fusion section absent ⇒ output byte-unchanged", async () => {
	const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
	const before = formatAnalysisTerminal(result);
	expect(before).not.toContain("Runtime-Prioritized");
	expect(result.fusionViews).toBeUndefined();
});

test("matched, zero findings, degraded coverage ⇒ not 'clean' (R2-9/R2-10)", async () => {
	const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
	const h = result.hotspots[0];
	result.fusionViews = {
		hotspotAnnotations: [{ attrKey: `${h.functionName}_${h.objectType}_${h.objectId}`,
			status: "matched", attributionConfidence: "exact", findings: [],
			matchedClean: undefined, reason: "matched; coverage incomplete" }],
		prioritizedFindings: [], unweightedFindings: [],
		correlationSummary: { matched: 1, matchedClean: 0, ambiguous: 0, blindSpot: 0, coldCount: 0, unkeyableCount: 0, orphanCount: 0 },
	};
	const out = formatAnalysisTerminal(result);
	expect(out).toContain("coverage incomplete");
	expect(out).not.toContain("no static findings"); // must not imply clean
});
```

Add the JSON byte-unchanged check: serialize `result` without `fusionViews` and confirm `result.hotspots[i]` has no injected fusion keys (R2-5).

- [ ] **Step 7: Run, format, lint, typecheck**

```bash
bun test test/cli/formatters/
bun run format && bun run lint && bun run typecheck
```
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add src/output/sections.ts src/cli/formatters/terminal.ts src/cli/formatters/markdown.ts src/cli/formatters/html.ts test/cli/formatters/
git commit -m "feat(p2.1): fusion CLI section + in-place hotspot annotation (terminal/markdown/html)"
```

---

## Task 4: MCP surface — P2.2

**Files:**
- Modify: `src/mcp/server.ts`
- Test: `test/mcp/server.test.ts`

Satisfies R2-12 (drop cold findings from MCP), honesty propagation.

- [ ] **Step 1: Write failing tests**

In `test/mcp/server.test.ts`, add cases: (a) `analyze_profile` with a workspace `sourcePath` includes a `fusion` block in the JSON text output (annotations + prioritized findings + summary), and that block excludes cold/orphan findings; (b) a `prioritized_findings` tool exists and returns only `selfTimePercent > 0` rows plus the summary counts; (c) profile-only call (no sourcePath) is unchanged (no fusion block). Follow the existing harness (call the tool handler, parse `JSON.parse(res.content[0].text)`).

- [ ] **Step 2: Run, verify fail**

Run: `bun test test/mcp/server.test.ts`
Expected: FAIL — no fusion block / no `prioritized_findings` tool.

- [ ] **Step 3: Augment `analyze_profile`**

In the `analyze_profile` handler, after `result` is built and when `resolvedSourcePath` is an AL workspace, run fusion and attach a TRIMMED block (R2-12 — only weighted findings inline; cold summarized by count):

```typescript
import { fuseProfile } from "../semantic/fuse.js";
import { annotateHotspots, prioritizeFindings } from "../semantic/views.js";
import { isAlWorkspaceDir } from "../semantic/engine-runner.js"; // or wherever the guard lives
// ... inside the handler, after result is assembled, before returning:
let allMethods: MethodBreakdown[] = result.hotspots; // analyzeProfile already truncated; for MCP, request untruncated:
// Prefer the onAllMethods callback (mirror analyze.ts): capture allMethods in the analyzeProfile options above.
if (resolvedSourcePath && isAlWorkspaceDir(resolvedSourcePath)) {
	const fuseResult = await fuseProfile(allMethods, resolvedSourcePath);
	if (!("disabled" in fuseResult)) {
		const { weighted } = prioritizeFindings(fuseResult, allMethods);
		(result as AnalysisResult).fusionViews = {
			hotspotAnnotations: annotateHotspots(fuseResult, allMethods),
			prioritizedFindings: weighted,
			unweightedFindings: [], // R2-12: NOT inlined for MCP
			correlationSummary: fuseResult.correlationSummary,
		};
	}
}
```

(Implementer: capture `allMethods` via the `onAllMethods` callback in the `analyzeProfile` options here too, exactly like Task 2 Step 3, so MCP also feeds untruncated methods — R2-7.)

- [ ] **Step 4: Add the `prioritized_findings` tool**

```typescript
server.registerTool(
	"prioritized_findings",
	{
		title: "Runtime-Prioritized Static Findings",
		description:
			"Which al-sem static findings sit on the routines that actually burn CPU. Ranked by self-time. Requires an AL source workspace alongside the profile.",
		inputSchema: {
			profilePath: z.string().describe("Path to the .alcpuprofile file"),
			sourcePath: z.string().optional().describe("Path to the AL source workspace"),
			top: z.number().int().min(1).max(100).default(20).describe("Max findings to return"),
		},
	},
	async ({ profilePath, sourcePath, top }) => {
		try {
			let allMethods: MethodBreakdown[] = [];
			const resolved = sourcePath ?? options?.defaultSourcePath;
			await analyzeProfile(profilePath, {
				includePatterns: true,
				sourcePath: resolved,
				onAllMethods: (m) => { allMethods = m; },
			});
			if (!resolved || !isAlWorkspaceDir(resolved)) {
				return { content: [{ type: "text" as const, text: JSON.stringify({ disabled: "no AL workspace" }) }] };
			}
			const fuseResult = await fuseProfile(allMethods, resolved);
			if ("disabled" in fuseResult) {
				return { content: [{ type: "text" as const, text: JSON.stringify({ disabled: fuseResult.reason }) }] };
			}
			const { weighted } = prioritizeFindings(fuseResult, allMethods);
			return { content: [{ type: "text" as const, text: JSON.stringify({
				prioritizedFindings: weighted.slice(0, top),
				correlationSummary: fuseResult.correlationSummary,
			}, null, 2) }] };
		} catch (error) {
			return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
		}
	},
);
```

- [ ] **Step 5: Run, format, lint, typecheck**

```bash
bun test test/mcp/server.test.ts
bun run format && bun run lint && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts test/mcp/server.test.ts
git commit -m "feat(p2.2): MCP fusion block + prioritized_findings tool (cold findings summarized, not inlined)"
```

---

## Task 5: Web surface — P2.3

**Files:**
- Modify: `web/public/app.js` (renderFusion + annotate renderHotspots + dispatch + sidebar)
- Modify: `web/public/index.html` (section div)
- Modify: `web/server.ts` ONLY if the payload strips unknown keys (verify it serializes the full `result`)
- Test: `test/web/server.test.ts`

Satisfies R2-6 (hand-written client renderer is the real work).

- [ ] **Step 1: Verify the server payload carries fusionViews**

Read `web/server.ts` `runAnalysis`: it returns `{ result, debugToken }`. Confirm `result` is serialized whole to the client (no allow-list). If the client receives `data` = the full `AnalysisResult`, `data.fusionViews` is already present. If a transform strips it, add `fusionViews` to the transform. (The web analyze path must also call fusion — mirror Task 2: capture `onAllMethods`, call `fuseProfile`, attach `result.fusionViews` in `runAnalysis` before returning.)

- [ ] **Step 2: Add fusion into the web analyze path**

In `web/server.ts` `runAnalysis`, after `result` is built and when `sourcePath` is an AL workspace, attach `result.fusionViews` exactly as Task 2 Step 3 (import `fuseProfile`/`annotateHotspots`/`prioritizeFindings`, capture `allMethods` via `onAllMethods`). Web MAY include `unweightedFindings` (unlike MCP).

- [ ] **Step 3: Add the section div + sidebar to index.html**

In `web/public/index.html`, add after `<div id="hotspots-section"></div>`:

```html
		<div id="fusion-section"></div>
```

- [ ] **Step 4: Add `renderFusion` + dispatch + sidebar entry in app.js**

In `web/public/app.js`:
- Add to the `sections` array (the SECTION_ORDER mirror), after the hotspots entry: `{ id: "fusion-section", label: "Prioritized Findings" }`.
- Add `renderFusion(data);` call in `renderResults` right after `renderHotspots(data);`.
- Implement `renderFusion`:

```javascript
function renderFusion(data) {
	const section = document.getElementById("fusion-section");
	if (!section) return;
	section.innerHTML = "";
	const fv = data.fusionViews;
	if (!fv || !fv.prioritizedFindings || fv.prioritizedFindings.length === 0) return;

	const title = document.createElement("div");
	title.className = "section-title";
	title.textContent = "Runtime-Prioritized Static Findings";
	section.appendChild(title);

	const wrapper = document.createElement("div");
	wrapper.className = "table-wrapper";
	const table = document.createElement("table");
	table.innerHTML = "<thead><tr><th>#</th><th>Finding</th><th>Detector</th><th>Routine</th><th>Self%</th><th>Total%</th><th>Severity</th></tr></thead>";
	const tbody = document.createElement("tbody");
	fv.prioritizedFindings.forEach((p, i) => {
		const tr = document.createElement("tr");
		const amb = p.frameCount > 1 ? " (×" + p.frameCount + " ambiguous)" : "";
		tr.innerHTML =
			"<td>" + (i + 1) + "</td>" +
			"<td>" + escapeHtml(p.finding.title) + amb + "</td>" +
			"<td>" + escapeHtml(p.finding.detector) + "</td>" +
			"<td class='mono'>" + escapeHtml(p.functionName) + "</td>" +
			"<td>" + p.selfTimePercent.toFixed(1) + "</td>" +
			"<td>" + p.totalTimePercent.toFixed(1) + "</td>" +
			"<td>" + escapeHtml(p.finding.severity) + "</td>";
		tbody.appendChild(tr);
	});
	table.appendChild(tbody);
	wrapper.appendChild(table);
	section.appendChild(wrapper);
}
```

- Annotate hotspots in place: inside `renderHotspots`'s `rebuildTbody`, after building each `tr`, when `data.fusionViews` is present, look up the annotation by `h.functionName + "_" + h.objectType + "_" + h.objectId` and append a sub-row `<tr><td colspan="8">↳ …</td></tr>` (cause / "ambiguous" / "coverage incomplete" / "no static findings" only when matchedClean). Gate on `data.fusionViews` so off-state is unchanged.

- [ ] **Step 5: Web test**

In `test/web/server.test.ts`, add a test that the analysis payload includes `fusionViews` when a workspace is provided (or, if the engine can't run in CI, assert the field is absent and the payload is otherwise complete). Follow the existing web test harness.

- [ ] **Step 6: Run, format, lint, typecheck**

```bash
bun test test/web/server.test.ts
bun run format && bun run lint && bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add web/public/app.js web/public/index.html web/server.ts test/web/server.test.ts
git commit -m "feat(p2.3): web fusion section + in-place hotspot annotation (client renderer)"
```

---

## Task 6: Batch out-of-scope note + full suite green — R2-11

**Files:**
- Modify: `docs/superpowers/specs/2026-06-10-phase-p2-fusion-ux-design.md` (already states it) — no code.

- [ ] **Step 1: Confirm batch renders nothing**

`batch-analyzer.ts` never calls `fuseProfile`, and `batch-html.ts` uses its own `BatchSectionRenderers`/`BATCH_SECTION_ORDER` (no `fusion` member) → batch output is unaffected. Verify by running the batch tests:

Run: `bun test test/` (full suite)
Expected: ALL GREEN. Batch tests unchanged.

- [ ] **Step 2: Full quality gate**

```bash
bun run format && bun run lint && bun run typecheck && bun test
```
Expected: clean + all green.

- [ ] **Step 3: Final commit if any formatting churn**

```bash
git add -u
git commit -m "chore(p2): full suite green; batch fusion out of scope (R2-11)"
```

---

## Self-Review (run before dispatching)

- **Spec coverage:** R2-1 (Task 2), R2-2 (Task 3 Step 2), R2-3 (Task 1 cmpPrioritized), R2-4 (Task 3 in-place + fusion=prioritized-only), R2-5 (Task 3 no hotspots[i] mutation + JSON test), R2-6 (Task 5), R2-7 (Task 2 onAllMethods), R2-8 (Task 1 SUM), R2-9/R2-10 (Task 1 + Task 3 honesty tests), R2-11 (Task 6), R2-12 (Task 4 trimmed MCP), R2-13 (corroboratingPatterns — carried through in annotation; leaf-only POPULATION is deferred to P3 unless trivially available, see note below), R2-14 (Task 1 byte-stable test).
- **R2-13 caveat:** P1's `correlate.ts` does not yet populate `corroboratingPatterns`. This plan CARRIES the field through the views (so renderers display it when present) but does NOT implement the patterns.ts cross-match. Per R2-13's escape hatch ("if leaf-gating proves too thin, defer entirely to P3"), the cross-match POPULATION is deferred to P3; the slot is plumbed end-to-end now. This is a deliberate scope decision — flag it to the reviewer.
- **Type consistency:** `methodAttrKey` shape `${functionName}_${objectType}_${objectId}` used identically in views.ts, all 3 CLI renderers, and app.js. `FusionViews` defined once in views.ts, imported by types.ts.
- **No placeholders:** every step has real code or a concrete command.
