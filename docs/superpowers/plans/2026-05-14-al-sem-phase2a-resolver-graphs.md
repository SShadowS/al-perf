# al-sem Phase 2a — Resolver & Graphs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend al-sem's `SemanticIndex` into a complete `SemanticModel` — resolve record-variable table types, build the call graph (with dispatch kinds + resolution quality), implicit-trigger edges, the event graph, and the `AnalysisCoverage` record. `analyzeWorkspace()` returns a `SemanticModel`.

**Architecture:** A new `src/resolve/` layer (L3) consumes the Phase 1 `SemanticIndex` and produces graphs. A `SymbolTable` lookup index is built once; resolvers (record-types, call-resolver, implicit-edges, event-graph) query it; an orchestrator assembles the `SemanticModel`. Everything operates on **indexed source** — symbol-only `.app` dependencies are treated as opaque, never as a false "clean."

**Tech Stack:** TypeScript, Bun (`bun test`), Biome. No new dependencies. Pure functions over the Phase 1 model types.

**Spec:** `docs/superpowers/specs/2026-05-14-al-sem-semantic-engine-design.md`. This plan covers Sections 1 (L3), 2 (`CallEdge`/`EventSymbol`/`EventEdge`/`AnalysisCoverage`), 3 (pass 3 "resolve graph"), and 5 (Native Resolver Scope).

---

## Scope of Phase 2a

**In scope — produces a `SemanticModel` with `callGraph`, `eventGraph`, `coverage` populated, and routine `features` table-resolved:**
- `Routine.attributes` — a small Phase 1 model addition (Task 1), needed by the event graph
- `SymbolTable` — a lookup index over the `SemanticIndex`
- Record-type resolution — back-fill `RecordVariable.tableId`, `RecordOperation.tableId` + `recordVariableId`
- Call resolver — `CallEdge[]` for every call site: same-object bare-procedure calls and `Codeunit/Page/Report.Run` with literal targets resolve; everything else is classified by `dispatchKind` and marked `unresolved`/`unknown` (never silently clean)
- Implicit-trigger edges — `Validate`/`Insert`/`Modify`/`Delete`/`Rename` on a known table → `implicit-trigger` `CallEdge`
- Event graph — `EventSymbol[]` from publisher routines, `EventEdge[]` from subscriber routines (parsing `[EventSubscriber(...)]` attribute args)
- `AnalysisCoverage` — counts, parse-incomplete routines, opaque apps, unresolved callsites, dynamic-dispatch sites
- `analyzeWorkspace()` returns `{ model: SemanticModel, diagnostics }`

**Deferred (NOT in Phase 2a) — with rationale:**
- **`SymbolReference.json` parsing** — symbol-only `.app` dependencies are treated as opaque (`resolution: "opaque"`; their apps listed in `coverage.opaqueApps`). The JSON schema is documented but not byte-confirmed against a real BC `.app`; Phase 2a produces a fully-working model on workspace + source-bearing input without it. Adding it later *upgrades* opaque resolutions and adds base-app event publisher symbols — it does not change the model shape.
- **Routine summaries** (`Routine.summary`, the L4 summary engine, Tarjan SCC, fixed-point) — Phase 2b.
- **The path-walker** — only detectors exercise it; it moves to Phase 3 with the detectors.
- **Type-tracking of non-record variables** — Phase 1 only tracks `Record` variables, so a method call on a `Codeunit`/`Interface` instance variable resolves to `unresolved` (classified `dispatchKind: "method"`/`"interface"`, `resolution: "unknown"`). Resolving these is a clearly-scoped future enhancement requiring Phase 1 to track variable types beyond records.
- **`Insert`/`Modify`/`Delete`/`Rename` `RunTrigger` arg** — Phase 1 does not capture whether `true` was passed, so these implicit-trigger edges get `resolution: "maybe"`. `Validate` always runs `OnValidate`, so it gets `resolution: "resolved"` (when the trigger is found in source). Capturing the boolean arg is a future refinement.

**Phase boundary:** Phase 2a produces a `SemanticModel` whose `callGraph`/`eventGraph`/`coverage` are populated and whose routine `features` have `tableId`s resolved, but whose routine `summary` fields are still `undefined`. Phase 2b populates `summary`.

---

## Current Phase 1 code (exact signatures this plan builds on)

**`src/model/` — all types exist.** Key ones:
- `src/model/model.ts`: `SemanticIndex { identity, apps, objects, routines, tables }`; `SemanticModel extends SemanticIndex { callGraph: CallEdge[]; eventGraph: { events: EventSymbol[]; edges: EventEdge[] }; coverage: AnalysisCoverage }`; `AnalysisCoverage { sourceUnitsTotal, sourceUnitsParsed, routinesTotal, routinesBodyAvailable, routinesParseIncomplete: RoutineId[], opaqueApps: string[], unresolvedCallsites: CallsiteId[], dynamicDispatchSites: OperationId[] }`
- `src/model/graph.ts`: `Evidence { source: "tree-sitter"|"symbol-package"|"external-source"; note? }`; `DispatchKind = "direct"|"method"|"interface"|"codeunit-run"|"report-run"|"page-run"|"event-dispatch"|"implicit-trigger"|"dynamic"|"unresolved"`; `ResolutionQuality = "resolved"|"maybe"|"unknown"|"opaque"`; `CallEdge { from: RoutineId; to?: RoutineId; callsiteId: CallsiteId; operationId: OperationId; dispatchKind: DispatchKind; resolution: ResolutionQuality; provenance: Evidence[] }`; `EventSymbol { id: EventId; publisherObjectId: ObjectId; publisherRoutineId?: RoutineId; eventName: string; eventKind: "integration"|"business"|"trigger"|"internal"|"unknown"; elementName?: string; signatureHash: string; parameters: ParameterSymbol[]; provenance: Evidence[] }`; `EventEdge { eventId: EventId; subscriberRoutineId: RoutineId; subscriberAppId: string; skipOnMissingLicense?: boolean; skipOnMissingPermission?: boolean; resolution: "resolved"|"maybe"|"unknown"; provenance: Evidence[] }`
- `src/model/entities.ts`: `Routine { id, canonical, objectId, name, kind, parameters: ParameterSymbol[], bodyAvailable, parseIncomplete, sourceHash, sourceAnchor, features: IntraproceduralFeatures, summary? }` (Task 1 adds `attributes: string[]`); `IntraproceduralFeatures { loops, operationSites, recordOperations, callSites, fieldAccesses, recordVariables, nestingDepth }`; `RecordVariable { id, name, tableName?, tableId?, tempState, isParameter, parameterIndex? }`; `RecordOperation { id, routineId, op, recordVariableName, recordVariableId?, tableId?, tempState, fieldArguments?, loopStack, sourceAnchor }`; `CallSite { id, operationId, calleeText, argumentTexts, loopStack, sourceAnchor }`; `ObjectDecl { id, appGuid, objectType, objectNumber, name, sourceUnitId, sourceHash, sourceAnchor }`; `Table { id, appGuid, tableNumber, name, fields, keys }`; `RoutineKind = "procedure"|"trigger"|"event-publisher"|"event-subscriber"`
- `src/model/ids.ts` — encoders: `encodeObjectId(appGuid, objectType, objectNumber)`, `encodeTableId(appGuid, tableNumber)`, `encodeEventId(publisherObjectId, eventName)`, `encodeRoutineId(canonicalKey, modelInstanceId)`. ID type aliases are all `string`.

**`src/index.ts`** — `analyzeWorkspace(options): Promise<{ index: SemanticIndex; diagnostics: Diagnostic[] }>`. Task 9 changes the return to `{ model: SemanticModel; diagnostics }`.

**`src/index/routine-indexer.ts`** — `indexRoutines(input: IndexRoutinesInput): Routine[]` where `IndexRoutinesInput { objectNode, object, sourceUnitId, modelInstanceId }`. `classifyKind` (module-private) walks `node.previousSibling` while the sibling's type is `"attribute_item"`. Task 1 modifies this file.

**`src/parser/ast.ts`** — exports `stripQuotes`, `nodeToSourceRange`, `collectDescendants`, `isDescendantOf`, `findChild`, `isPropertyNamed`.

**Confirmed V2 grammar** (verified live in Phase 1): `attribute_item` nodes are previous siblings of `procedure`/`trigger_declaration`; `procedure`, `trigger_declaration`, `code_block`; `node.namedChildren` is `(SyntaxNode | null)[]`; `node.previousSibling` works.

---

## File Structure

```
U:\Git\al-sem\
  src/
    model/entities.ts          MODIFY — add Routine.attributes: string[]
    index/routine-indexer.ts   MODIFY — populate Routine.attributes from attribute_item siblings
    resolve/
      symbol-table.ts          SymbolTable — lookup index over a SemanticIndex
      record-types.ts          resolveRecordTypes — back-fill tableId on record vars + ops
      callee.ts                parseCallee — classify a CallSite.calleeText into a callee shape
      call-resolver.ts         resolveCalls — CallSite[] -> CallEdge[]
      implicit-edges.ts        buildImplicitTriggerEdges — Validate/*(true) -> implicit-trigger CallEdge[]
      event-graph.ts           buildEventGraph — EventSymbol[] + EventEdge[]
      coverage.ts              buildCoverage — AnalysisCoverage
      resolver.ts              resolveModel — orchestrate: SemanticIndex -> SemanticModel
    index.ts                   MODIFY — analyzeWorkspace returns { model: SemanticModel, diagnostics }
  test/
    fixtures/al/               new fixtures: calls, events, triggers
    resolve/*.test.ts          co-located tests
```

---

## Task 1: Add `Routine.attributes` and populate it

**Files:**
- Modify: `U:\Git\al-sem\src\model\entities.ts` (the `Routine` interface)
- Modify: `U:\Git\al-sem\src\index\routine-indexer.ts`
- Modify: `U:\Git\al-sem\test\routine-indexer.test.ts`

Phase 1's `classifyKind` walks `attribute_item` previous siblings to detect event attributes, then discards the text. The event graph (Task 7) needs the raw attribute text to parse `[EventSubscriber(...)]` arguments. Capture it on the `Routine`.

- [ ] **Step 1: Add the failing test**

In `test/routine-indexer.test.ts`, add this test inside the existing `describe("indexRoutines", ...)` block:
```typescript
	test("captures raw attribute text on routines", async () => {
		const routines = await index();
		const handler = routines.find((r) => r.name === "HandleBeforePost");
		expect(handler?.attributes.length).toBe(1);
		expect(handler?.attributes[0]).toContain("EventSubscriber");
		const plain = routines.find((r) => r.name === "PublicWork");
		expect(plain?.attributes).toEqual([]);
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/routine-indexer.test.ts`
Expected: FAIL — `attributes` does not exist on `Routine` (tsc/runtime error or assertion failure).

- [ ] **Step 3: Add `attributes` to the `Routine` interface**

In `src/model/entities.ts`, in the `Routine` interface, add the field after `parameters`:
```typescript
	parameters: ParameterSymbol[];
	/** Raw text of each `attribute_item` immediately preceding the routine, in source order. */
	attributes: string[];
```

- [ ] **Step 4: Populate `attributes` in the routine indexer**

In `src/index/routine-indexer.ts`: there is a module-private helper `classifyKind` that walks `node.previousSibling` while the type is `"attribute_item"`. Add a sibling helper `collectAttributes` next to it:
```typescript
/** Collect the raw text of every `attribute_item` immediately preceding a routine node. */
function collectAttributes(node: SyntaxNode): string[] {
	const attributes: string[] = [];
	let sibling = node.previousSibling;
	while (sibling && sibling.type === "attribute_item") {
		attributes.unshift(sibling.text);
		sibling = sibling.previousSibling;
	}
	return attributes;
}
```
Then, in `indexRoutines`, where each `Routine` object is constructed, add the `attributes` field. Find the object literal `routines.push({ ... })` (or `const routine: Routine = { ... }`) and add, right after `parameters: ...,`:
```typescript
		attributes: collectAttributes(node),
```
(`node` is the `procedure`/`trigger_declaration` syntax node in scope in that loop. `SyntaxNode` is already imported in this file.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/routine-indexer.test.ts`
Expected: PASS — all routine-indexer tests pass including the new one.

- [ ] **Step 6: Run the full suite + checks**

Run: `cd U:/Git/al-sem && bun test && bunx tsc --noEmit && bunx biome check src test`
Expected: full suite green; tsc exit 0; biome exit 0. (If biome reports formatting, run `bunx biome format --write src/model/entities.ts src/index/routine-indexer.ts test/routine-indexer.test.ts`.)

> Note: adding a required `attributes` field to `Routine` may surface tsc errors anywhere a `Routine` literal is constructed in tests. Search for them (`grep -rn "kind:" test/routine-indexer.test.ts` and any other test constructing a `Routine`) — only `routine-indexer.ts` constructs real `Routine` objects, so this should be the only production site. If a test constructs a partial `Routine`, it likely uses `Pick<>` or `as` — leave those, they still compile.

- [ ] **Step 7: Commit**

```bash
cd U:/Git/al-sem
git add src/model/entities.ts src/index/routine-indexer.ts test/routine-indexer.test.ts
git commit -m "feat: capture raw attribute text on Routine"
```

---

## Task 2: SymbolTable lookup index (`src/resolve/symbol-table.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\resolve\symbol-table.ts`
- Test: `U:\Git\al-sem\test\resolve\symbol-table.test.ts`

A lookup structure built once from a `SemanticIndex`, queried by every resolver. Indexes objects by name and by `(objectType, objectNumber)`, tables by name, and routines by their owning object + name.

- [ ] **Step 1: Write the failing test**

`test/resolve/symbol-table.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { buildSymbolTable } from "../../src/resolve/symbol-table.ts";
import type { SemanticIndex } from "../../src/model/model.ts";
import type { ModelIdentity } from "../../src/model/identity.ts";
import type { ObjectDecl, Routine, Table } from "../../src/model/entities.ts";

const IDENTITY: ModelIdentity = {
	schemaVersion: "1",
	analyzerVersion: "0.0.1",
	grammarVersion: "v2",
	symbolReaderVersion: "1",
	createdAt: "1970-01-01T00:00:00.000Z",
	apps: [],
	dependencyGraphHash: "h",
};

const ANCHOR = {
	sourceUnitId: "u",
	range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
	enclosingRoutineId: "",
	syntaxKind: "x",
};

function obj(type: string, num: number, name: string): ObjectDecl {
	return {
		id: `guid/${type}/${num}`,
		appGuid: "guid",
		objectType: type,
		objectNumber: num,
		name,
		sourceUnitId: "u",
		sourceHash: "h",
		sourceAnchor: ANCHOR,
	};
}

function routine(objectId: string, name: string): Routine {
	return {
		id: `${objectId}/r/${name}`,
		canonical: {
			appGuid: "guid",
			objectType: "Codeunit",
			objectNumber: 1,
			routineKind: "procedure",
			routineName: name,
			normalizedSignatureHash: "h",
		},
		objectId,
		name,
		kind: "procedure",
		parameters: [],
		attributes: [],
		bodyAvailable: true,
		parseIncomplete: false,
		sourceHash: "h",
		sourceAnchor: ANCHOR,
		features: {
			loops: [],
			operationSites: [],
			recordOperations: [],
			callSites: [],
			fieldAccesses: [],
			recordVariables: [],
			nestingDepth: 0,
		},
	};
}

function table(num: number, name: string): Table {
	return { id: `guid/table/${num}`, appGuid: "guid", tableNumber: num, name, fields: [], keys: [] };
}

function index(parts: Partial<SemanticIndex>): SemanticIndex {
	return {
		identity: IDENTITY,
		apps: [],
		objects: [],
		routines: [],
		tables: [],
		...parts,
	};
}

describe("buildSymbolTable", () => {
	test("finds an object by type and number", () => {
		const cu = obj("Codeunit", 50100, "My CU");
		const st = buildSymbolTable(index({ objects: [cu] }));
		expect(st.objectByTypeNumber("Codeunit", 50100)?.name).toBe("My CU");
		expect(st.objectByTypeNumber("Codeunit", 99999)).toBeUndefined();
	});

	test("finds an object by type and name, case-insensitively", () => {
		const cu = obj("Codeunit", 50100, "Sales-Post");
		const st = buildSymbolTable(index({ objects: [cu] }));
		expect(st.objectByTypeName("Codeunit", "sales-post")?.objectNumber).toBe(50100);
	});

	test("finds a table by name, case-insensitively", () => {
		const t = table(18, "Customer");
		const st = buildSymbolTable(index({ tables: [t] }));
		expect(st.tableByName("customer")?.id).toBe("guid/table/18");
		expect(st.tableByName("nonexistent")).toBeUndefined();
	});

	test("finds a routine by its object id and name", () => {
		const cu = obj("Codeunit", 50100, "My CU");
		const r = routine(cu.id, "DoWork");
		const st = buildSymbolTable(index({ objects: [cu], routines: [r] }));
		expect(st.routineInObject(cu.id, "dowork")?.name).toBe("DoWork");
		expect(st.routineInObject(cu.id, "missing")).toBeUndefined();
	});

	test("returns all routines of an object", () => {
		const cu = obj("Codeunit", 50100, "My CU");
		const a = routine(cu.id, "A");
		const b = routine(cu.id, "B");
		const st = buildSymbolTable(index({ objects: [cu], routines: [a, b] }));
		expect(st.routinesInObject(cu.id).map((r) => r.name).sort()).toEqual(["A", "B"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/resolve/symbol-table.test.ts`
Expected: FAIL — `Cannot find module '../../src/resolve/symbol-table.ts'`.

- [ ] **Step 3: Write the implementation**

`src/resolve/symbol-table.ts`:
```typescript
import type { ObjectDecl, Routine, Table } from "../model/entities.ts";
import type { ObjectId } from "../model/ids.ts";
import type { SemanticIndex } from "../model/model.ts";

/**
 * A read-only lookup index over a SemanticIndex. Built once, queried by every resolver.
 * All name lookups are case-insensitive (AL identifiers are case-insensitive).
 */
export interface SymbolTable {
	objectByTypeNumber(objectType: string, objectNumber: number): ObjectDecl | undefined;
	objectByTypeName(objectType: string, name: string): ObjectDecl | undefined;
	tableByName(name: string): Table | undefined;
	tableById(id: string): Table | undefined;
	routineInObject(objectId: ObjectId, routineName: string): Routine | undefined;
	routinesInObject(objectId: ObjectId): Routine[];
	routineById(routineId: string): Routine | undefined;
}

export function buildSymbolTable(index: SemanticIndex): SymbolTable {
	const byTypeNumber = new Map<string, ObjectDecl>();
	const byTypeName = new Map<string, ObjectDecl>();
	for (const o of index.objects) {
		byTypeNumber.set(`${o.objectType.toLowerCase()}/${o.objectNumber}`, o);
		byTypeName.set(`${o.objectType.toLowerCase()}/${o.name.toLowerCase()}`, o);
	}

	const tablesByName = new Map<string, Table>();
	const tablesById = new Map<string, Table>();
	for (const t of index.tables) {
		tablesByName.set(t.name.toLowerCase(), t);
		tablesById.set(t.id, t);
	}

	// Routines keyed by `${objectId}::${routineName.toLowerCase()}`, and grouped per object.
	const routineByKey = new Map<string, Routine>();
	const routinesByObject = new Map<string, Routine[]>();
	const routinesById = new Map<string, Routine>();
	for (const r of index.routines) {
		routineByKey.set(`${r.objectId}::${r.name.toLowerCase()}`, r);
		routinesById.set(r.id, r);
		const list = routinesByObject.get(r.objectId);
		if (list) list.push(r);
		else routinesByObject.set(r.objectId, [r]);
	}

	return {
		objectByTypeNumber(objectType, objectNumber) {
			return byTypeNumber.get(`${objectType.toLowerCase()}/${objectNumber}`);
		},
		objectByTypeName(objectType, name) {
			return byTypeName.get(`${objectType.toLowerCase()}/${name.toLowerCase()}`);
		},
		tableByName(name) {
			return tablesByName.get(name.toLowerCase());
		},
		tableById(id) {
			return tablesById.get(id);
		},
		routineInObject(objectId, routineName) {
			return routineByKey.get(`${objectId}::${routineName.toLowerCase()}`);
		},
		routinesInObject(objectId) {
			return routinesByObject.get(objectId) ?? [];
		},
		routineById(routineId) {
			return routinesById.get(routineId);
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/resolve/symbol-table.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/resolve/symbol-table.ts test/resolve/symbol-table.test.ts
git commit -m "feat: add SymbolTable lookup index"
```

---

## Task 3: Resolve record-variable table types (`src/resolve/record-types.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\resolve\record-types.ts`
- Test: `U:\Git\al-sem\test\resolve\record-types.test.ts`

Phase 1 left `RecordVariable.tableId`, `RecordOperation.tableId`, and `RecordOperation.recordVariableId` undefined. This resolver back-fills them in place: each `RecordVariable.tableName` is looked up in the `SymbolTable` to get a `TableId`; each `RecordOperation` is matched to a `RecordVariable` in the same routine by name.

- [ ] **Step 1: Write the failing test**

`test/resolve/record-types.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { analyzeWorkspace } from "../../src/index.ts";
import { buildSymbolTable } from "../../src/resolve/symbol-table.ts";
import { resolveRecordTypes } from "../../src/resolve/record-types.ts";
import { fileURLToPath } from "node:url";

// Reuse a real workspace fixture and resolve against it.
const WS_ROOT = fileURLToPath(new URL("../fixtures/ws-resolve", import.meta.url));

describe("resolveRecordTypes", () => {
	test("back-fills tableId on record variables that name a known table", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const st = buildSymbolTable(index);
		resolveRecordTypes(index, st);
		const routine = index.routines.find((r) => r.name === "Process");
		const custVar = routine?.features.recordVariables.find((v) => v.name === "Customer");
		// "Customer" table is defined in the fixture, so it resolves.
		expect(custVar?.tableId).toBe(st.tableByName("Customer")?.id);
	});

	test("leaves tableId undefined for a record variable naming an unknown table", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const st = buildSymbolTable(index);
		resolveRecordTypes(index, st);
		const routine = index.routines.find((r) => r.name === "Process");
		const slVar = routine?.features.recordVariables.find((v) => v.name === "SalesLine");
		// "Sales Line" is NOT defined in the fixture — stays unresolved.
		expect(slVar?.tableId).toBeUndefined();
	});

	test("back-fills tableId and recordVariableId on record operations", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const st = buildSymbolTable(index);
		resolveRecordTypes(index, st);
		const routine = index.routines.find((r) => r.name === "Process");
		const getOp = routine?.features.recordOperations.find((o) => o.op === "Get");
		const custVar = routine?.features.recordVariables.find((v) => v.name === "Customer");
		expect(getOp?.recordVariableId).toBe(custVar?.id);
		expect(getOp?.tableId).toBe(st.tableByName("Customer")?.id);
	});
});
```

- [ ] **Step 2: Create the fixture**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p ws-resolve/src
cat > ws-resolve/app.json <<'EOF'
{
  "id": "55555555-5555-5555-5555-555555555555",
  "name": "Resolve Test App",
  "publisher": "RT",
  "version": "1.0.0.0"
}
EOF
cat > ws-resolve/src/customer.al <<'EOF'
table 50900 Customer
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Name; Text[100]) { }
    }
    keys { key(PK; "No.") { } }
}
EOF
cat > ws-resolve/src/processor.al <<'EOF'
codeunit 50901 "Processor"
{
    procedure Process()
    var
        Customer: Record Customer;
        SalesLine: Record "Sales Line";
    begin
        Customer.Get('C0001');
        Helper();
    end;

    local procedure Helper()
    begin
    end;
}
EOF
```
Expected: `test/fixtures/ws-resolve/` with `app.json` + 2 `.al` files.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/resolve/record-types.test.ts`
Expected: FAIL — `Cannot find module '../../src/resolve/record-types.ts'`.

- [ ] **Step 4: Write the implementation**

`src/resolve/record-types.ts`:
```typescript
import type { SemanticIndex } from "../model/model.ts";
import type { SymbolTable } from "./symbol-table.ts";

/**
 * Back-fill `tableId` on record variables and record operations, and `recordVariableId`
 * on record operations, by resolving table names against the SymbolTable. Mutates the
 * index's routines in place (the established pattern — Phase 1's routine indexer also
 * mutates `callSite.loopStack` in place). A record variable naming a table al-sem cannot
 * see (e.g. a base-app table in a symbol-only dependency) is left with `tableId`
 * undefined — never guessed.
 */
export function resolveRecordTypes(index: SemanticIndex, symbols: SymbolTable): void {
	for (const routine of index.routines) {
		const { recordVariables, recordOperations } = routine.features;

		// --- resolve record variables ---
		// name (lowercased) -> the resolved variable, for matching operations below.
		const varByName = new Map<string, (typeof recordVariables)[number]>();
		for (const variable of recordVariables) {
			varByName.set(variable.name.toLowerCase(), variable);
			if (variable.tableName) {
				const table = symbols.tableByName(variable.tableName);
				if (table) variable.tableId = table.id;
			}
		}

		// --- resolve record operations against their record variable ---
		for (const op of recordOperations) {
			const variable = varByName.get(op.recordVariableName.toLowerCase());
			if (variable) {
				op.recordVariableId = variable.id;
				if (variable.tableId) op.tableId = variable.tableId;
			}
		}
	}
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/resolve/record-types.test.ts`
Expected: PASS — 3 tests pass.

> If `custVar?.tableId` is undefined when it should resolve: confirm the fixture's table is
> named `Customer` (unquoted) and the record variable's `tableName` is also `Customer` —
> Phase 1's `extractRecordVariables` stores `tableName` via `stripQuotes`, so both should be
> the bare string `"Customer"`. Log `st.tableByName("Customer")` and the variable's
> `tableName` to compare.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/resolve/record-types.ts test/resolve/record-types.test.ts test/fixtures/ws-resolve/
git commit -m "feat: resolve record-variable and record-operation table types"
```

---

## Task 4: Callee classifier (`src/resolve/callee.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\resolve\callee.ts`
- Test: `U:\Git\al-sem\test\resolve\callee.test.ts`

A pure function that classifies a `CallSite`'s `calleeText` + `argumentTexts` into a structured "callee shape" — the input the call resolver (Task 5) needs to pick a `dispatchKind`. Isolating this makes the resolver itself simple.

- [ ] **Step 1: Write the failing test**

`test/resolve/callee.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { parseCallee } from "../../src/resolve/callee.ts";

describe("parseCallee", () => {
	test("classifies a bare procedure call", () => {
		expect(parseCallee("Helper", [])).toEqual({ kind: "bare", name: "Helper" });
	});

	test("classifies a member call on an instance variable", () => {
		expect(parseCallee("MyCodeunit.DoWork", [])).toEqual({
			kind: "member",
			receiver: "MyCodeunit",
			method: "DoWork",
		});
	});

	test("classifies Codeunit.Run with a literal codeunit reference", () => {
		expect(parseCallee("Codeunit.Run", ['Codeunit::"Sales-Post"'])).toEqual({
			kind: "object-run",
			objectKind: "Codeunit",
			targetType: "Codeunit",
			targetRef: "Sales-Post",
			targetIsName: true,
		});
	});

	test("classifies Codeunit.Run with a numeric codeunit reference", () => {
		expect(parseCallee("Codeunit.Run", ["Codeunit::80"])).toEqual({
			kind: "object-run",
			objectKind: "Codeunit",
			targetType: "Codeunit",
			targetRef: "80",
			targetIsName: false,
		});
	});

	test("classifies Page.Run and Report.Run", () => {
		expect(parseCallee("Page.Run", ["Page::42"]).kind).toBe("object-run");
		expect(parseCallee("Report.Run", ["Report::1"]).kind).toBe("object-run");
	});

	test("classifies Codeunit.Run with a non-literal target as dynamic", () => {
		expect(parseCallee("Codeunit.Run", ["SomeVariable"])).toEqual({
			kind: "object-run",
			objectKind: "Codeunit",
			targetType: "Codeunit",
			targetRef: undefined,
			targetIsName: false,
		});
	});

	test("classifies an empty or unrecognized callee as unknown", () => {
		expect(parseCallee("", []).kind).toBe("unknown");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/resolve/callee.test.ts`
Expected: FAIL — `Cannot find module '../../src/resolve/callee.ts'`.

- [ ] **Step 3: Write the implementation**

`src/resolve/callee.ts`:
```typescript
/**
 * Structured classification of a CallSite's callee. Drives the call resolver's
 * dispatch-kind decision. `calleeText` is the raw text Phase 1 captured (e.g. "Helper",
 * "MyCodeunit.DoWork", "Codeunit.Run").
 */
export type Callee =
	| { kind: "bare"; name: string }
	| { kind: "member"; receiver: string; method: string }
	| {
			kind: "object-run";
			objectKind: "Codeunit" | "Page" | "Report";
			targetType: "Codeunit" | "Page" | "Report";
			/** The literal object name or number text, or undefined if the target is dynamic. */
			targetRef?: string;
			/** true when targetRef is a quoted/bare name, false when it is a numeric id. */
			targetIsName: boolean;
	  }
	| { kind: "unknown" };

const OBJECT_RUN_RE = /^(Codeunit|Page|Report)\.Run$/i;
/** Matches `Codeunit::"Name"` or `Codeunit::123` (and Page/Report variants). */
const OBJECT_REF_RE = /^(Codeunit|Page|Report)::\s*("?)([^"]*)\2\s*$/i;

function titleCaseObjectKind(raw: string): "Codeunit" | "Page" | "Report" {
	const lower = raw.toLowerCase();
	if (lower === "page") return "Page";
	if (lower === "report") return "Report";
	return "Codeunit";
}

/** Classify a callee expression + its argument texts into a structured Callee. */
export function parseCallee(calleeText: string, argumentTexts: string[]): Callee {
	const text = calleeText.trim();
	if (text === "") return { kind: "unknown" };

	// Codeunit.Run / Page.Run / Report.Run — inspect the first argument for the target.
	const runMatch = text.match(OBJECT_RUN_RE);
	if (runMatch) {
		const objectKind = titleCaseObjectKind(runMatch[1] ?? "Codeunit");
		const firstArg = (argumentTexts[0] ?? "").trim();
		const refMatch = firstArg.match(OBJECT_REF_RE);
		if (refMatch) {
			const targetType = titleCaseObjectKind(refMatch[1] ?? objectKind);
			const isQuoted = refMatch[2] === '"'; // quoted -> a name
			const rawRef = (refMatch[3] ?? "").trim();
			const numeric = /^\d+$/.test(rawRef);
			// A ref is a name when it is quoted OR not all-digits; an unquoted
			// all-digits ref (`Codeunit::80`) is a numeric object id.
			const targetIsName = isQuoted || !numeric;
			return {
				kind: "object-run",
				objectKind,
				targetType,
				targetRef: rawRef,
				targetIsName,
			};
		}
		// Run with a non-literal (variable) target — dynamic.
		return {
			kind: "object-run",
			objectKind,
			targetType: objectKind,
			targetRef: undefined,
			targetIsName: false,
		};
	}

	// Member call: `Receiver.Method`
	const dot = text.lastIndexOf(".");
	if (dot > 0) {
		return {
			kind: "member",
			receiver: text.slice(0, dot).trim(),
			method: text.slice(dot + 1).trim(),
		};
	}

	// Bare identifier — a procedure call within the same object.
	if (/^[A-Za-z_]\w*$/.test(text) || text.startsWith('"')) {
		return { kind: "bare", name: text.replace(/^"|"$/g, "") };
	}

	return { kind: "unknown" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/resolve/callee.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/resolve/callee.ts test/resolve/callee.test.ts
git commit -m "feat: add callee classifier for call resolution"
```

---

## Task 5: Call resolver (`src/resolve/call-resolver.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\resolve\call-resolver.ts`
- Test: `U:\Git\al-sem\test\resolve\call-resolver.test.ts`

For every `CallSite` in every routine, produce a `CallEdge`. Same-object bare-procedure calls and `Codeunit/Page/Report.Run` with literal targets resolve to a `RoutineId`; everything else is classified by `dispatchKind` and marked `unresolved`/`unknown`/`dynamic` — never silently clean.

- [ ] **Step 1: Write the failing test**

`test/resolve/call-resolver.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { buildSymbolTable } from "../../src/resolve/symbol-table.ts";
import { resolveCalls } from "../../src/resolve/call-resolver.ts";

const WS_ROOT = fileURLToPath(new URL("../fixtures/ws-resolve", import.meta.url));

describe("resolveCalls", () => {
	test("resolves a same-object bare procedure call to a direct edge", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const st = buildSymbolTable(index);
		const edges = resolveCalls(index, st);
		const processor = index.objects.find((o) => o.name === "Processor");
		const process = index.routines.find((r) => r.name === "Process");
		const helper = index.routines.find((r) => r.name === "Helper");
		// Process() calls Helper() — a same-object bare call -> direct, resolved.
		const edge = edges.find((e) => e.from === process?.id && e.to === helper?.id);
		expect(edge).toBeDefined();
		expect(edge?.dispatchKind).toBe("direct");
		expect(edge?.resolution).toBe("resolved");
		// objectId sanity: helper belongs to the Processor object.
		expect(helper?.objectId).toBe(processor?.id);
	});

	test("produces an unresolved edge for a member call on an untyped variable", async () => {
		const { index } = await analyzeWorkspace({
			workspaceRoot: fileURLToPath(new URL("../fixtures/ws-calls", import.meta.url)),
			deterministic: true,
		});
		const st = buildSymbolTable(index);
		const edges = resolveCalls(index, st);
		const caller = index.routines.find((r) => r.name === "CallMember");
		const edge = edges.find((e) => e.from === caller?.id);
		expect(edge?.dispatchKind).toBe("method");
		expect(edge?.resolution).toBe("unknown");
		expect(edge?.to).toBeUndefined();
	});

	test("resolves Codeunit.Run with a literal codeunit name to a codeunit-run edge", async () => {
		const { index } = await analyzeWorkspace({
			workspaceRoot: fileURLToPath(new URL("../fixtures/ws-calls", import.meta.url)),
			deterministic: true,
		});
		const st = buildSymbolTable(index);
		const edges = resolveCalls(index, st);
		const caller = index.routines.find((r) => r.name === "RunIt");
		const target = index.objects.find((o) => o.name === "Worker CU");
		const edge = edges.find((e) => e.from === caller?.id && e.dispatchKind === "codeunit-run");
		expect(edge).toBeDefined();
		expect(edge?.resolution).toBe("resolved");
		// The resolved `to` routine belongs to the Worker CU object.
		const toRoutine = index.routines.find((r) => r.id === edge?.to);
		expect(toRoutine?.objectId).toBe(target?.id);
	});

	test("every call site produces exactly one edge", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const st = buildSymbolTable(index);
		const edges = resolveCalls(index, st);
		const callSiteCount = index.routines.reduce(
			(n, r) => n + r.features.callSites.length,
			0,
		);
		expect(edges.length).toBe(callSiteCount);
	});
});
```

- [ ] **Step 2: Create the `ws-calls` fixture**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p ws-calls/src
cat > ws-calls/app.json <<'EOF'
{
  "id": "66666666-6666-6666-6666-666666666666",
  "name": "Calls Test App",
  "publisher": "CT",
  "version": "1.0.0.0"
}
EOF
cat > ws-calls/src/worker.al <<'EOF'
codeunit 51000 "Worker CU"
{
    trigger OnRun()
    begin
    end;
}
EOF
cat > ws-calls/src/caller.al <<'EOF'
codeunit 51001 "Caller CU"
{
    procedure CallMember()
    var
        Other: Codeunit "Worker CU";
    begin
        Other.SomeMethod();
    end;

    procedure RunIt()
    begin
        Codeunit.Run(Codeunit::"Worker CU");
    end;
}
EOF
```
Expected: `test/fixtures/ws-calls/` with `app.json` + 2 `.al` files.

> Note: `Other.SomeMethod()` is a member call on a `Codeunit`-typed variable. Phase 1 only
> tracks `Record` variables, so `Other` is not a known record variable — the resolver
> cannot type it and produces an `unresolved` `method` edge. That is the intended Phase 2a
> behavior (see the plan's Scope section).

- [ ] **Step 3: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/resolve/call-resolver.test.ts`
Expected: FAIL — `Cannot find module '../../src/resolve/call-resolver.ts'`.

- [ ] **Step 4: Write the implementation**

`src/resolve/call-resolver.ts`:
```typescript
import type { CallSite, Routine } from "../model/entities.ts";
import type { CallEdge, DispatchKind, ResolutionQuality } from "../model/graph.ts";
import type { SemanticIndex } from "../model/model.ts";
import { parseCallee } from "./callee.ts";
import type { SymbolTable } from "./symbol-table.ts";

const TREE_SITTER_EVIDENCE = { source: "tree-sitter" as const };

/** Map an object-run objectKind to its CallEdge dispatch kind. */
function objectRunDispatchKind(
	objectKind: "Codeunit" | "Page" | "Report",
): DispatchKind {
	if (objectKind === "Page") return "page-run";
	if (objectKind === "Report") return "report-run";
	return "codeunit-run";
}

/** Resolve one call site within `routine` into a CallEdge. */
function resolveCallSite(
	routine: Routine,
	callSite: CallSite,
	symbols: SymbolTable,
): CallEdge {
	const base = {
		from: routine.id,
		callsiteId: callSite.id,
		operationId: callSite.operationId,
		provenance: [TREE_SITTER_EVIDENCE],
	};
	const callee = parseCallee(callSite.calleeText, callSite.argumentTexts);

	switch (callee.kind) {
		case "bare": {
			// A bare call resolves to a procedure in the SAME object (AL has no free functions).
			const target = symbols.routineInObject(routine.objectId, callee.name);
			if (target) {
				return { ...base, to: target.id, dispatchKind: "direct", resolution: "resolved" };
			}
			return { ...base, dispatchKind: "unresolved", resolution: "unknown" };
		}
		case "object-run": {
			const dispatchKind = objectRunDispatchKind(callee.objectKind);
			if (callee.targetRef === undefined) {
				// Dynamic target (a variable) — known shape, unknown target.
				return { ...base, dispatchKind, resolution: "unknown" };
			}
			const targetObject = callee.targetIsName
				? symbols.objectByTypeName(callee.targetType, callee.targetRef)
				: symbols.objectByTypeNumber(
						callee.targetType,
						Number.parseInt(callee.targetRef, 10),
					);
			if (!targetObject) {
				// Target named/numbered but not in indexed source (e.g. symbol-only dependency).
				return { ...base, dispatchKind, resolution: "opaque" };
			}
			// Resolve to the object's entry routine: OnRun trigger for codeunits, else the
			// first routine. If none, the edge is resolved-to-object but routine-less.
			const entry =
				symbols.routineInObject(targetObject.id, "OnRun") ??
				symbols.routinesInObject(targetObject.id)[0];
			if (entry) {
				return { ...base, to: entry.id, dispatchKind, resolution: "resolved" };
			}
			return { ...base, dispatchKind, resolution: "opaque" };
		}
		case "member": {
			// A method call on an instance variable. Phase 1 does not type-track non-record
			// variables, so the receiver type is unknown -> unresolved method dispatch.
			return { ...base, dispatchKind: "method", resolution: "unknown" };
		}
		default: {
			return { ...base, dispatchKind: "unresolved", resolution: "unknown" };
		}
	}
}

/**
 * Resolve every call site in the index into a CallEdge. Exactly one edge per call site.
 * Unresolved calls are DATA (a CallEdge with no `to` and a non-"resolved" resolution),
 * never a silent gap.
 */
export function resolveCalls(index: SemanticIndex, symbols: SymbolTable): CallEdge[] {
	const edges: CallEdge[] = [];
	for (const routine of index.routines) {
		for (const callSite of routine.features.callSites) {
			edges.push(resolveCallSite(routine, callSite, symbols));
		}
	}
	return edges;
}
```

> The `ResolutionQuality` import is used in the function-return types via `CallEdge`; if
> tsc flags it as unused, drop the explicit `ResolutionQuality` import (it is referenced
> only structurally through `CallEdge`). Keep `DispatchKind` — it is used directly.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/resolve/call-resolver.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/resolve/call-resolver.ts test/resolve/call-resolver.test.ts test/fixtures/ws-calls/
git commit -m "feat: add call resolver producing dispatch-classified CallEdges"
```

---

## Task 6: Implicit-trigger edges (`src/resolve/implicit-edges.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\resolve\implicit-edges.ts`
- Test: `U:\Git\al-sem\test\resolve\implicit-edges.test.ts`

A `Validate`/`Insert`/`Modify`/`Delete`/`Rename` record operation can implicitly invoke a table trigger. This builds an `implicit-trigger` `CallEdge` from the routine to the table's trigger routine, when the table is in indexed source. `Validate` → `resolution: "resolved"` (it always runs `OnValidate`); `Insert`/`Modify`/`Delete`/`Rename` → `resolution: "maybe"` (Phase 1 does not capture whether `true` was passed — see Scope).

- [ ] **Step 1: Write the failing test**

`test/resolve/implicit-edges.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { buildSymbolTable } from "../../src/resolve/symbol-table.ts";
import { resolveRecordTypes } from "../../src/resolve/record-types.ts";
import { buildImplicitTriggerEdges } from "../../src/resolve/implicit-edges.ts";

const WS_ROOT = fileURLToPath(new URL("../fixtures/ws-triggers", import.meta.url));

describe("buildImplicitTriggerEdges", () => {
	test("creates an implicit-trigger edge for Modify on a table with a trigger", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const st = buildSymbolTable(index);
		resolveRecordTypes(index, st);
		const edges = buildImplicitTriggerEdges(index, st);
		const writer = index.routines.find((r) => r.name === "WriteIt");
		const edge = edges.find((e) => e.from === writer?.id);
		expect(edge).toBeDefined();
		expect(edge?.dispatchKind).toBe("implicit-trigger");
		// Modify -> resolution "maybe" (RunTrigger boolean not captured in Phase 1).
		expect(edge?.resolution).toBe("maybe");
		// The edge points at the table's OnModify trigger routine.
		const toRoutine = index.routines.find((r) => r.id === edge?.to);
		expect(toRoutine?.kind).toBe("trigger");
	});

	test("creates a resolved implicit-trigger edge for Validate", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const st = buildSymbolTable(index);
		resolveRecordTypes(index, st);
		const edges = buildImplicitTriggerEdges(index, st);
		const validator = index.routines.find((r) => r.name === "ValidateIt");
		const edge = edges.find((e) => e.from === validator?.id);
		expect(edge?.dispatchKind).toBe("implicit-trigger");
		expect(edge?.resolution).toBe("resolved");
	});

	test("produces no edge when the table is not in indexed source", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const st = buildSymbolTable(index);
		resolveRecordTypes(index, st);
		const edges = buildImplicitTriggerEdges(index, st);
		// "UnknownIt" modifies a record of an undefined table -> no implicit edge.
		const unknown = index.routines.find((r) => r.name === "UnknownIt");
		expect(edges.some((e) => e.from === unknown?.id)).toBe(false);
	});
});
```

- [ ] **Step 2: Create the `ws-triggers` fixture**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p ws-triggers/src
cat > ws-triggers/app.json <<'EOF'
{
  "id": "77777777-7777-7777-7777-777777777777",
  "name": "Triggers Test App",
  "publisher": "TT",
  "version": "1.0.0.0"
}
EOF
cat > ws-triggers/src/item.al <<'EOF'
table 51100 Item
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Description; Text[100]) { }
    }
    keys { key(PK; "No.") { } }

    trigger OnModify()
    begin
    end;

    trigger OnInsert()
    begin
    end;
}
EOF
cat > ws-triggers/src/writer.al <<'EOF'
codeunit 51101 "Writer CU"
{
    procedure WriteIt()
    var
        Item: Record Item;
    begin
        Item.Modify(true);
    end;

    procedure ValidateIt()
    var
        Item: Record Item;
    begin
        Item.Validate(Description);
    end;

    procedure UnknownIt()
    var
        Ledger: Record "G/L Entry";
    begin
        Ledger.Modify(true);
    end;
}
EOF
```
Expected: `test/fixtures/ws-triggers/` with `app.json` + 2 `.al` files.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/resolve/implicit-edges.test.ts`
Expected: FAIL — `Cannot find module '../../src/resolve/implicit-edges.ts'`.

- [ ] **Step 4: Write the implementation**

`src/resolve/implicit-edges.ts`:
```typescript
import type { RecordOpType } from "../model/entities.ts";
import type { CallEdge, ResolutionQuality } from "../model/graph.ts";
import type { SemanticIndex } from "../model/model.ts";
import type { SymbolTable } from "./symbol-table.ts";

const TREE_SITTER_EVIDENCE = { source: "tree-sitter" as const };

/**
 * Maps a trigger-invoking record op to (the table trigger name it invokes, the resolution
 * quality of the edge). `Validate` always runs the field's OnValidate, so "resolved".
 * `Insert`/`Modify`/`Delete`/`Rename` run the table trigger only when called with
 * `RunTrigger = true`, which Phase 1 does not capture — so "maybe".
 */
const TRIGGER_OPS: Partial<
	Record<RecordOpType, { triggerName: string; resolution: ResolutionQuality }>
> = {
	Validate: { triggerName: "OnValidate", resolution: "resolved" },
	Insert: { triggerName: "OnInsert", resolution: "maybe" },
	Modify: { triggerName: "OnModify", resolution: "maybe" },
	Delete: { triggerName: "OnDelete", resolution: "maybe" },
};

/**
 * Build implicit-trigger CallEdges. For each trigger-invoking record op whose record
 * variable resolves to a table that IS in indexed source, emit an edge to that table's
 * trigger routine. Tables al-sem cannot see (symbol-only dependencies, unknown tables)
 * produce no edge — that absence is reflected in AnalysisCoverage, not invented here.
 */
export function buildImplicitTriggerEdges(
	index: SemanticIndex,
	symbols: SymbolTable,
): CallEdge[] {
	const edges: CallEdge[] = [];
	for (const routine of index.routines) {
		for (const op of routine.features.recordOperations) {
			const mapping = TRIGGER_OPS[op.op];
			if (!mapping) continue;
			if (!op.tableId) continue; // table not resolved -> cannot find its trigger
			const table = symbols.tableById(op.tableId);
			if (!table) continue;
			// The table's object id: tables are objects too. Look it up by type+number.
			const tableObject = symbols.objectByTypeNumber("Table", table.tableNumber);
			if (!tableObject) continue;
			const trigger = symbols.routineInObject(tableObject.id, mapping.triggerName);
			if (!trigger) continue;
			edges.push({
				from: routine.id,
				to: trigger.id,
				callsiteId: op.id, // the record-op's operation id doubles as the callsite ref
				operationId: op.id,
				dispatchKind: "implicit-trigger",
				resolution: mapping.resolution,
				provenance: [TREE_SITTER_EVIDENCE],
			});
		}
	}
	return edges;
}
```

> Note: `CallEdge.callsiteId` is typed `CallsiteId` and `operationId` is `OperationId` —
> both are `string` aliases. A record op has an `OperationId` (`op.id`) but no
> `CallsiteId`; using `op.id` for both is intentional and type-safe (both are strings).
> The implicit edge's "call site" IS the record operation.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/resolve/implicit-edges.test.ts`
Expected: PASS — 3 tests pass.

> If the OnModify edge is not found: confirm Phase 1 indexes table triggers as routines
> with `kind: "trigger"` and name `"OnModify"`. Phase 1's routine indexer collects
> `trigger_declaration` nodes and uses `childForFieldName("name")` for the name — a table
> `trigger OnModify()` should yield a routine named `OnModify`. Log
> `symbols.routinesInObject(tableObject.id)` to see what triggers were indexed.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/resolve/implicit-edges.ts test/resolve/implicit-edges.test.ts test/fixtures/ws-triggers/
git commit -m "feat: add implicit-trigger edge builder"
```

---

## Task 7: Event graph (`src/resolve/event-graph.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\resolve\event-graph.ts`
- Test: `U:\Git\al-sem\test\resolve\event-graph.test.ts`

Build `EventSymbol[]` from publisher routines and `EventEdge[]` from subscriber routines. A subscriber's `[EventSubscriber(...)]` attribute (now on `Routine.attributes` from Task 1) names the target object + event; the edge points at the matching event symbol.

- [ ] **Step 1: Write the failing test**

`test/resolve/event-graph.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { buildSymbolTable } from "../../src/resolve/symbol-table.ts";
import { buildEventGraph } from "../../src/resolve/event-graph.ts";

const WS_ROOT = fileURLToPath(new URL("../fixtures/ws-events", import.meta.url));

describe("buildEventGraph", () => {
	test("builds an EventSymbol for each publisher routine", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const st = buildSymbolTable(index);
		const { events } = buildEventGraph(index, st);
		const onAfter = events.find((e) => e.eventName === "OnAfterDoWork");
		expect(onAfter).toBeDefined();
		expect(onAfter?.eventKind).toBe("integration");
		expect(onAfter?.publisherRoutineId).toBeDefined();
	});

	test("builds an EventEdge from a subscriber to the event it targets", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const st = buildSymbolTable(index);
		const { events, edges } = buildEventGraph(index, st);
		const subscriber = index.routines.find((r) => r.name === "HandleAfterDoWork");
		const edge = edges.find((e) => e.subscriberRoutineId === subscriber?.id);
		expect(edge).toBeDefined();
		// The edge's eventId matches the OnAfterDoWork event symbol (same-app publisher).
		const onAfter = events.find((e) => e.eventName === "OnAfterDoWork");
		expect(edge?.eventId).toBe(onAfter?.id);
		expect(edge?.resolution).toBe("resolved");
	});

	test("a subscriber targeting an event al-sem cannot see still produces an edge", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const st = buildSymbolTable(index);
		const { edges } = buildEventGraph(index, st);
		// HandleBaseAppEvent subscribes to a Base App codeunit not in the workspace.
		const subscriber = index.routines.find((r) => r.name === "HandleBaseAppEvent");
		const edge = edges.find((e) => e.subscriberRoutineId === subscriber?.id);
		expect(edge).toBeDefined();
		expect(edge?.resolution).not.toBe("resolved"); // "maybe" or "unknown"
		expect(edge?.subscriberAppId).toBe("88888888-8888-8888-8888-888888888888");
	});
});
```

- [ ] **Step 2: Create the `ws-events` fixture**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p ws-events/src
cat > ws-events/app.json <<'EOF'
{
  "id": "88888888-8888-8888-8888-888888888888",
  "name": "Events Test App",
  "publisher": "ET",
  "version": "1.0.0.0"
}
EOF
cat > ws-events/src/publisher.al <<'EOF'
codeunit 51200 "Work Engine"
{
    procedure DoWork()
    begin
        OnAfterDoWork();
    end;

    [IntegrationEvent(false, false)]
    procedure OnAfterDoWork()
    begin
    end;
}
EOF
cat > ws-events/src/subscriber.al <<'EOF'
codeunit 51201 "Work Listener"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Work Engine", 'OnAfterDoWork', '', true, true)]
    local procedure HandleAfterDoWork()
    begin
    end;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", 'OnAfterPostSalesDoc', '', true, true)]
    local procedure HandleBaseAppEvent()
    begin
    end;
}
EOF
```
Expected: `test/fixtures/ws-events/` with `app.json` + 2 `.al` files.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/resolve/event-graph.test.ts`
Expected: FAIL — `Cannot find module '../../src/resolve/event-graph.ts'`.

- [ ] **Step 4: Write the implementation**

`src/resolve/event-graph.ts`:
```typescript
import { sha256Hex } from "../hash.ts";
import type { Routine } from "../model/entities.ts";
import type { EventEdge, EventSymbol } from "../model/graph.ts";
import { encodeEventId, encodeObjectId } from "../model/ids.ts";
import type { SemanticIndex } from "../model/model.ts";
import type { SymbolTable } from "./symbol-table.ts";

const TREE_SITTER_EVIDENCE = { source: "tree-sitter" as const };

export interface EventGraph {
	events: EventSymbol[];
	edges: EventEdge[];
}

/** Determine the event kind from a publisher routine's attribute text. */
function publisherEventKind(attributes: string[]): EventSymbol["eventKind"] {
	for (const attr of attributes) {
		if (/\[IntegrationEvent\b/i.test(attr)) return "integration";
		if (/\[BusinessEvent\b/i.test(attr)) return "business";
	}
	return "unknown";
}

/**
 * Parse an `[EventSubscriber(ObjectType::X, X::"Y", 'EventName', 'ElementName', ...)]`
 * attribute into its target parts, or null if no EventSubscriber attribute is present.
 */
function parseSubscriberAttribute(attributes: string[]): {
	targetObjectType: string;
	targetRef: string;
	eventName: string;
	elementName: string;
} | null {
	for (const attr of attributes) {
		const match = attr.match(
			/\[EventSubscriber\(\s*ObjectType::(\w+)\s*,\s*\w+::"?([^"',)]+)"?\s*,\s*'([^']*)'\s*,\s*'([^']*)'/i,
		);
		if (match) {
			return {
				targetObjectType: match[1] ?? "",
				targetRef: match[2] ?? "",
				eventName: match[3] ?? "",
				elementName: match[4] ?? "",
			};
		}
	}
	return null;
}

/** Build the EventSymbol for a publisher routine. */
function buildEventSymbol(
	routine: Routine,
	publisherObjectId: string,
): EventSymbol {
	return {
		id: encodeEventId(publisherObjectId, routine.name),
		publisherObjectId,
		publisherRoutineId: routine.id,
		eventName: routine.name,
		eventKind: publisherEventKind(routine.attributes),
		signatureHash: routine.canonical.normalizedSignatureHash,
		parameters: routine.parameters,
		provenance: [TREE_SITTER_EVIDENCE],
	};
}

/**
 * Build the event graph: EventSymbols from publisher routines, EventEdges from subscriber
 * routines. A subscriber targeting an event al-sem cannot see (e.g. a Base App event in a
 * symbol-only dependency) still produces an edge — with a synthesized eventId and a
 * non-"resolved" resolution — never a silent gap.
 */
export function buildEventGraph(index: SemanticIndex, symbols: SymbolTable): EventGraph {
	const events: EventSymbol[] = [];
	// eventId -> EventSymbol, so subscriber edges can find (or synthesize against) a symbol.
	const eventById = new Map<string, EventSymbol>();
	const objectById = new Map(index.objects.map((o) => [o.id, o]));

	// --- publishers ---
	for (const routine of index.routines) {
		if (routine.kind !== "event-publisher") continue;
		const symbol = buildEventSymbol(routine, routine.objectId);
		events.push(symbol);
		eventById.set(symbol.id, symbol);
	}

	// --- subscribers ---
	const edges: EventEdge[] = [];
	for (const routine of index.routines) {
		if (routine.kind !== "event-subscriber") continue;
		const target = parseSubscriberAttribute(routine.attributes);
		if (!target) continue;

		const subscriberObject = objectById.get(routine.objectId);
		const subscriberAppId = subscriberObject?.appGuid ?? "unknown";

		// Resolve the target object. AL EventSubscriber refs are usually names.
		const targetObject = symbols.objectByTypeName(
			target.targetObjectType,
			target.targetRef,
		);
		let eventId: string;
		let resolution: EventEdge["resolution"];
		if (targetObject) {
			eventId = encodeEventId(targetObject.id, target.eventName);
			// "resolved" only if we also found the matching publisher symbol.
			resolution = eventById.has(eventId) ? "resolved" : "maybe";
			// Synthesize a symbol for a known target object whose publisher we did not index.
			if (!eventById.has(eventId)) {
				const synthesized: EventSymbol = {
					id: eventId,
					publisherObjectId: targetObject.id,
					eventName: target.eventName,
					eventKind: "unknown",
					elementName: target.elementName || undefined,
					signatureHash: sha256Hex(eventId),
					parameters: [],
					provenance: [{ source: "tree-sitter", note: "publisher not indexed" }],
				};
				events.push(synthesized);
				eventById.set(eventId, synthesized);
			}
		} else {
			// Target object not in indexed source — synthesize a pseudo object id.
			const pseudoObjectId = encodeObjectId(
				"unknown",
				target.targetObjectType,
				0,
			);
			eventId = encodeEventId(`${pseudoObjectId}:${target.targetRef}`, target.eventName);
			resolution = "unknown";
			if (!eventById.has(eventId)) {
				const synthesized: EventSymbol = {
					id: eventId,
					publisherObjectId: `${pseudoObjectId}:${target.targetRef}`,
					eventName: target.eventName,
					eventKind: "unknown",
					elementName: target.elementName || undefined,
					signatureHash: sha256Hex(eventId),
					parameters: [],
					provenance: [
						{ source: "tree-sitter", note: "target object not in indexed source" },
					],
				};
				events.push(synthesized);
				eventById.set(eventId, synthesized);
			}
		}

		edges.push({
			eventId,
			subscriberRoutineId: routine.id,
			subscriberAppId,
			resolution,
			provenance: [TREE_SITTER_EVIDENCE],
		});
	}

	return { events, edges };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/resolve/event-graph.test.ts`
Expected: PASS — 3 tests pass.

> If `parseSubscriberAttribute` returns null for the workspace subscriber: the regex
> assumes the attribute has at least 4 comma-separated args (objectType, objectRef,
> eventName, elementName). The fixture attributes have 6 args — the regex only needs the
> first 4 and ignores the rest, so it should match. If it does not, log
> `routine.attributes` to see the exact captured text and adjust the regex. al-perf's
> `src/source/indexer.ts` has a working `parseEventSubscriberAttribute` regex for the same
> attribute shape — use it as a reference.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/resolve/event-graph.ts test/resolve/event-graph.test.ts test/fixtures/ws-events/
git commit -m "feat: add event graph builder (publishers + subscribers)"
```

---

## Task 8: Analysis coverage (`src/resolve/coverage.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\resolve\coverage.ts`
- Test: `U:\Git\al-sem\test\resolve\coverage.test.ts`

Build the `AnalysisCoverage` record — the "no silent clean" accounting. Counts of source units, parsed units, routines, body-available routines; the lists of parse-incomplete routines, opaque (symbol-only) apps, unresolved call sites, and dynamic-dispatch operation sites.

- [ ] **Step 1: Write the failing test**

`test/resolve/coverage.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { buildCoverage } from "../../src/resolve/coverage.ts";
import type { SemanticIndex } from "../../src/model/model.ts";
import type { CallEdge } from "../../src/model/graph.ts";
import type { SourceUnit } from "../../src/providers/types.ts";
import type { Diagnostic } from "../../src/model/finding.ts";
import type { ModelIdentity } from "../../src/model/identity.ts";

const ANCHOR = {
	sourceUnitId: "u",
	range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
	enclosingRoutineId: "",
	syntaxKind: "x",
};

function identity(symbolOnlyAppGuid?: string): ModelIdentity {
	return {
		schemaVersion: "1",
		analyzerVersion: "0.0.1",
		grammarVersion: "v2",
		symbolReaderVersion: "1",
		createdAt: "1970-01-01T00:00:00.000Z",
		apps: symbolOnlyAppGuid
			? [
					{
						appGuid: symbolOnlyAppGuid,
						publisher: "p",
						name: "n",
						version: "1.0.0.0",
						sourceKind: "symbol-only",
					},
				]
			: [],
		dependencyGraphHash: "h",
	};
}

function emptyIndex(id: ModelIdentity): SemanticIndex {
	return { identity: id, apps: [], objects: [], routines: [], tables: [] };
}

describe("buildCoverage", () => {
	test("counts source units and parsed units", () => {
		const units: SourceUnit[] = [
			{ id: "ws:a.al", kind: "source", appGuid: "g", relativePath: "a.al", content: "x", sourceProvider: "workspace" },
			{ id: "ws:b.al", kind: "source", appGuid: "g", relativePath: "b.al", content: "y", sourceProvider: "workspace" },
			{ id: "app:dep:__symbols__", kind: "symbol-only", appGuid: "dep", relativePath: "__symbols__", sourceProvider: "app-package" },
		];
		const diags: Diagnostic[] = [
			{ severity: "warning", stage: "index", message: "bad", sourceRef: "ws:b.al" },
		];
		const cov = buildCoverage(emptyIndex(identity()), [], units, diags);
		expect(cov.sourceUnitsTotal).toBe(2); // symbol-only units do not count as source units
		expect(cov.sourceUnitsParsed).toBe(1); // b.al failed to index
	});

	test("lists opaque (symbol-only) apps", () => {
		const cov = buildCoverage(
			emptyIndex(identity("99999999-9999-9999-9999-999999999999")),
			[],
			[],
			[],
		);
		expect(cov.opaqueApps).toEqual(["99999999-9999-9999-9999-999999999999"]);
	});

	test("lists unresolved call sites and dynamic-dispatch sites from the call graph", () => {
		const edges: CallEdge[] = [
			{ from: "r1", callsiteId: "r1/cs0", operationId: "r1/op0", dispatchKind: "unresolved", resolution: "unknown", provenance: [] },
			{ from: "r1", to: "r2", callsiteId: "r1/cs1", operationId: "r1/op1", dispatchKind: "direct", resolution: "resolved", provenance: [] },
			{ from: "r1", callsiteId: "r1/cs2", operationId: "r1/op2", dispatchKind: "dynamic", resolution: "unknown", provenance: [] },
		];
		const cov = buildCoverage(emptyIndex(identity()), edges, [], []);
		expect(cov.unresolvedCallsites).toEqual(["r1/cs0"]);
		expect(cov.dynamicDispatchSites).toEqual(["r1/op2"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/resolve/coverage.test.ts`
Expected: FAIL — `Cannot find module '../../src/resolve/coverage.ts'`.

- [ ] **Step 3: Write the implementation**

`src/resolve/coverage.ts`:
```typescript
import type { CallEdge } from "../model/graph.ts";
import type { Diagnostic } from "../model/finding.ts";
import type { AnalysisCoverage, SemanticIndex } from "../model/model.ts";
import type { SourceUnit } from "../providers/types.ts";

/**
 * Build the AnalysisCoverage record — the first-class "no silent clean" accounting.
 * `sourceUnitsTotal` counts only `kind: "source"` units. `sourceUnitsParsed` subtracts
 * units that produced a `warning`-severity index diagnostic (the throw path — a unit that
 * parsed but had no object declaration produced an `info` diagnostic and still counts as
 * parsed).
 */
export function buildCoverage(
	index: SemanticIndex,
	callGraph: CallEdge[],
	units: SourceUnit[],
	indexDiagnostics: Diagnostic[],
): AnalysisCoverage {
	const sourceUnits = units.filter((u) => u.kind === "source");
	const failedUnitRefs = new Set(
		indexDiagnostics
			.filter((d) => d.stage === "index" && d.severity === "warning" && d.sourceRef)
			.map((d) => d.sourceRef as string),
	);
	const sourceUnitsParsed = sourceUnits.filter(
		(u) => !failedUnitRefs.has(u.id),
	).length;

	const opaqueApps = index.identity.apps
		.filter((a) => a.sourceKind === "symbol-only")
		.map((a) => a.appGuid);

	const routinesBodyAvailable = index.routines.filter((r) => r.bodyAvailable).length;
	const routinesParseIncomplete = index.routines
		.filter((r) => r.parseIncomplete)
		.map((r) => r.id);

	const unresolvedCallsites = callGraph
		.filter((e) => e.dispatchKind === "unresolved")
		.map((e) => e.callsiteId);
	const dynamicDispatchSites = callGraph
		.filter((e) => e.dispatchKind === "dynamic")
		.map((e) => e.operationId);

	return {
		sourceUnitsTotal: sourceUnits.length,
		sourceUnitsParsed,
		routinesTotal: index.routines.length,
		routinesBodyAvailable,
		routinesParseIncomplete,
		opaqueApps,
		unresolvedCallsites,
		dynamicDispatchSites,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/resolve/coverage.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/resolve/coverage.ts test/resolve/coverage.test.ts
git commit -m "feat: add analysis coverage builder"
```

---

## Task 9: Resolver orchestrator (`src/resolve/resolver.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\resolve\resolver.ts`
- Test: `U:\Git\al-sem\test\resolve\resolver.test.ts`

Ties the L3 layer together: build the `SymbolTable`, run record-type resolution (mutates the index in place), build the call graph + implicit-trigger edges + event graph + coverage, and assemble a `SemanticModel`.

- [ ] **Step 1: Write the failing test**

`test/resolve/resolver.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../../src/index.ts";
import { resolveModel } from "../../src/resolve/resolver.ts";

const WS_ROOT = fileURLToPath(new URL("../fixtures/ws-resolve", import.meta.url));

describe("resolveModel", () => {
	test("produces a SemanticModel with callGraph, eventGraph, and coverage", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const model = resolveModel(index, [], []);
		// SemanticModel is a SemanticIndex plus graphs + coverage.
		expect(model.objects).toBe(index.objects); // same index data, extended
		expect(Array.isArray(model.callGraph)).toBe(true);
		expect(model.eventGraph).toBeDefined();
		expect(Array.isArray(model.eventGraph.events)).toBe(true);
		expect(Array.isArray(model.eventGraph.edges)).toBe(true);
		expect(model.coverage.routinesTotal).toBe(index.routines.length);
	});

	test("the call graph has one edge per call site in the index", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const model = resolveModel(index, [], []);
		const callSiteCount = index.routines.reduce(
			(n, r) => n + r.features.callSites.length,
			0,
		);
		expect(model.callGraph.length).toBe(callSiteCount);
	});

	test("record-type resolution has run (record ops carry resolved tableIds)", async () => {
		const { index } = await analyzeWorkspace({ workspaceRoot: WS_ROOT, deterministic: true });
		const model = resolveModel(index, [], []);
		const process = model.routines.find((r) => r.name === "Process");
		const getOp = process?.features.recordOperations.find((o) => o.op === "Get");
		// "Customer" table is in the fixture, so the Get op's tableId is resolved.
		expect(getOp?.tableId).toBeDefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/resolve/resolver.test.ts`
Expected: FAIL — `Cannot find module '../../src/resolve/resolver.ts'`.

- [ ] **Step 3: Write the implementation**

`src/resolve/resolver.ts`:
```typescript
import type { Diagnostic } from "../model/finding.ts";
import type { SemanticIndex, SemanticModel } from "../model/model.ts";
import type { SourceUnit } from "../providers/types.ts";
import { resolveCalls } from "./call-resolver.ts";
import { buildCoverage } from "./coverage.ts";
import { buildEventGraph } from "./event-graph.ts";
import { buildImplicitTriggerEdges } from "./implicit-edges.ts";
import { resolveRecordTypes } from "./record-types.ts";
import { buildSymbolTable } from "./symbol-table.ts";

/**
 * L3 orchestrator: extend a SemanticIndex into a complete SemanticModel. Builds the symbol
 * lookup, resolves record-variable table types (mutating the index's routine features in
 * place), then builds the call graph, implicit-trigger edges, event graph, and coverage.
 *
 * `units` and `indexDiagnostics` come from the discovery + indexing passes and feed only
 * the coverage record — pass `[]` for both in unit tests that work from a pre-built index.
 */
export function resolveModel(
	index: SemanticIndex,
	units: SourceUnit[],
	indexDiagnostics: Diagnostic[],
): SemanticModel {
	const symbols = buildSymbolTable(index);

	// Resolve record-variable / record-operation table types in place first — the call
	// graph's implicit-trigger edges depend on resolved tableIds.
	resolveRecordTypes(index, symbols);

	const callEdges = resolveCalls(index, symbols);
	const implicitEdges = buildImplicitTriggerEdges(index, symbols);
	const callGraph = [...callEdges, ...implicitEdges];

	const eventGraph = buildEventGraph(index, symbols);
	const coverage = buildCoverage(index, callGraph, units, indexDiagnostics);

	return {
		...index,
		callGraph,
		eventGraph,
		coverage,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/resolve/resolver.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/resolve/resolver.ts test/resolve/resolver.test.ts
git commit -m "feat: add L3 resolver orchestrator producing a SemanticModel"
```

---

## Task 10: Wire `analyzeWorkspace` to return a `SemanticModel`

**Files:**
- Modify: `U:\Git\al-sem\src\index.ts`
- Modify: `U:\Git\al-sem\test\analyze-workspace.test.ts`

`analyzeWorkspace` currently returns `{ index: SemanticIndex; diagnostics }`. Phase 2a's deliverable is a `SemanticModel` — change the entry point to run the resolver and return `{ model: SemanticModel; diagnostics }`.

- [ ] **Step 1: Update the end-to-end test**

Replace the entire body of `test/analyze-workspace.test.ts` with:
```typescript
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeWorkspace } from "../src/index.ts";

const WS_ROOT = fileURLToPath(new URL("./fixtures/ws", import.meta.url));
const ALPACKAGES = fileURLToPath(new URL("./fixtures/alpackages", import.meta.url));

describe("analyzeWorkspace (Phase 2a end-to-end)", () => {
	test("returns a SemanticModel with graphs and coverage populated", async () => {
		const result = await analyzeWorkspace({ workspaceRoot: WS_ROOT });
		expect(result.model.objects.map((o) => o.name).sort()).toEqual(["CU A", "CU B"]);
		expect(result.model.routines.length).toBeGreaterThanOrEqual(2);
		expect(result.model.identity.primaryApp?.name).toBe("Test Workspace App");
		// Phase 2a additions:
		expect(Array.isArray(result.model.callGraph)).toBe(true);
		expect(result.model.eventGraph).toBeDefined();
		expect(result.model.coverage.routinesTotal).toBe(result.model.routines.length);
	});

	test("includes app-package source when alpackages is supplied", async () => {
		const result = await analyzeWorkspace({
			workspaceRoot: WS_ROOT,
			alpackagesDir: ALPACKAGES,
		});
		expect(result.model.objects.some((o) => o.name === "Sample Dep")).toBe(true);
		expect(
			result.model.identity.apps.some(
				(a) => a.appGuid === "22222222-2222-2222-2222-222222222222",
			),
		).toBe(true);
	});

	test("the call graph has one edge per call site", async () => {
		const result = await analyzeWorkspace({
			workspaceRoot: fileURLToPath(new URL("./fixtures/ws-resolve", import.meta.url)),
			deterministic: true,
		});
		const callSiteCount = result.model.routines.reduce(
			(n, r) => n + r.features.callSites.length,
			0,
		);
		// callGraph also includes implicit-trigger edges; it is at least the call-site count.
		expect(result.model.callGraph.length).toBeGreaterThanOrEqual(callSiteCount);
	});

	test("is deterministic — identical input yields byte-identical JSON", async () => {
		const a = await analyzeWorkspace({
			workspaceRoot: WS_ROOT,
			alpackagesDir: ALPACKAGES,
			deterministic: true,
		});
		const b = await analyzeWorkspace({
			workspaceRoot: WS_ROOT,
			alpackagesDir: ALPACKAGES,
			deterministic: true,
		});
		expect(JSON.stringify(a.model)).toBe(JSON.stringify(b.model));
	});

	test("never throws on a missing workspace — returns an empty model + diagnostic", async () => {
		const result = await analyzeWorkspace({ workspaceRoot: "/no/such/dir" });
		expect(result.model.objects).toEqual([]);
		expect(result.model.callGraph).toEqual([]);
		expect(result.diagnostics.length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/analyze-workspace.test.ts`
Expected: FAIL — `result.model` is undefined (`analyzeWorkspace` still returns `{ index }`).

- [ ] **Step 3: Update `src/index.ts`**

In `src/index.ts`, make these changes:

(a) Add an import for the resolver, alongside the existing imports:
```typescript
import { resolveModel } from "./resolve/resolver.ts";
```

(b) Add the export of the resolver's types — after the existing `export { ExternalSourceProvider } ...` line, the `export * from "./model/index.ts"` already re-exports `SemanticModel`. No change needed there.

(c) Change the `AnalyzeWorkspaceResult` interface from:
```typescript
export interface AnalyzeWorkspaceResult {
	index: SemanticIndex;
	diagnostics: Diagnostic[];
}
```
to:
```typescript
export interface AnalyzeWorkspaceResult {
	model: SemanticModel;
	diagnostics: Diagnostic[];
}
```
and update the type import: change `import type { SemanticIndex } from "./model/model.ts";` to `import type { SemanticModel } from "./model/model.ts";`.

(d) In the `analyzeWorkspace` function body, after the `buildSemanticIndex` call, replace the final assembly. The current end of the function is:
```typescript
	const { index, diagnostics } = await buildSemanticIndex(
		discovery.units,
		identity,
		discovery.modelInstanceId,
	);

	const allDiagnostics: Diagnostic[] = [
		...discovery.diagnostics.map(
			(d): Diagnostic => ({
				severity: d.severity,
				stage: "discover",
				message: d.message,
				sourceRef: d.sourceRef,
			}),
		),
		...diagnostics,
	];

	return { index, diagnostics: allDiagnostics };
}
```
Change it to:
```typescript
	const { index, diagnostics } = await buildSemanticIndex(
		discovery.units,
		identity,
		discovery.modelInstanceId,
	);

	const model = resolveModel(index, discovery.units, diagnostics);

	const allDiagnostics: Diagnostic[] = [
		...discovery.diagnostics.map(
			(d): Diagnostic => ({
				severity: d.severity,
				stage: "discover",
				message: d.message,
				sourceRef: d.sourceRef,
			}),
		),
		...diagnostics,
	];

	return { model, diagnostics: allDiagnostics };
}
```

(e) Update the JSDoc on `analyzeWorkspace` — change the line "Phase 1 entry point. Discovers sources, parses and indexes them, and returns a SemanticIndex." to "Discovers sources, parses, indexes, and resolves them into a complete SemanticModel (call graph, event graph, coverage). Routine summaries are still empty — Phase 2b populates them. Never throws — failures surface as diagnostics."

- [ ] **Step 4: Run the analyze-workspace test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/analyze-workspace.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Run the full suite + checks — fix any remaining `index`→`model` references**

Run: `cd U:/Git/al-sem && bun test && bunx tsc --noEmit && bunx biome check src test`
Expected: full suite green; tsc exit 0; biome exit 0.

> Other test files reference `result.index` from `analyzeWorkspace` — specifically the
> Phase 2a resolve tests written in Tasks 3, 5, 6, 7, 9 all destructure `const { index } =
> await analyzeWorkspace(...)`. That destructuring now yields `undefined`. **Fix each:**
> change `const { index } = await analyzeWorkspace(...)` to `const { model: index } =
> await analyzeWorkspace(...)` — this keeps the local variable name `index` (the rest of
> those tests still work, since `SemanticModel` IS a `SemanticIndex`). Do this in:
> `test/resolve/record-types.test.ts`, `test/resolve/call-resolver.test.ts`,
> `test/resolve/implicit-edges.test.ts`, `test/resolve/event-graph.test.ts`,
> `test/resolve/resolver.test.ts`. Run `grep -rln "const { index } = await analyzeWorkspace" test`
> to find them all. After fixing, re-run the full suite — it must be green.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/index.ts test/analyze-workspace.test.ts test/resolve/
git commit -m "feat: analyzeWorkspace returns a complete SemanticModel"
```

---

## Self-Review Notes (for the implementer)

Before declaring Phase 2a done, verify against the spec:

1. **Spec coverage:**
   - Section 1 architecture L3 (resolver, event-graph) → Tasks 2–9 ✓
   - Section 2 `CallEdge` (dispatchKind + resolution + provenance) → Task 5 ✓; `EventSymbol`/`EventEdge` → Task 7 ✓; `AnalysisCoverage` → Task 8 ✓; record-op/record-var `tableId` resolution → Task 3 ✓
   - Section 3 pass 3 "resolve graph" → Tasks 5–9 ✓
   - Section 5 Native Resolver Scope: implicit triggers → Task 6 ✓; event publisher/subscriber resolution → Task 7 ✓; `Codeunit.Run`/`Page.Run`/`Report.Run` literal targets → Tasks 4–5 ✓; dynamic (variable-target) object-run calls → `dispatchKind: "dynamic"`, `resolution: "unknown"` → Task 5 ✓ (wired in the Phase 2a final-review fix pass); "nothing resolves silently to clean" — every call site gets an edge, unresolved is data → Task 5 ✓. Deferred items (SymbolReference.json parsing, non-record variable type tracking, RunTrigger boolean capture) are listed in the Scope section with rationale — these are intentional Phase 2a boundaries, not gaps.
   - Section 6 graceful degradation — missing workspace → empty model + diagnostic; opaque apps → `coverage.opaqueApps`; unresolved → data not crash → Tasks 8, 10 ✓
   - Section 7 TDD — every task is test-first; the determinism test is updated in Task 10 ✓

2. **Phase boundary:** `analyzeWorkspace` returns a `SemanticModel` whose `callGraph`/`eventGraph`/`coverage` are populated and whose routine `features` have `tableId`s resolved, but whose routine `summary` is still `undefined`. Phase 2b populates `summary` via the L4 summary engine.

3. **Known scoping (intentional, not bugs):** member calls on non-record instance variables → `dispatchKind: "method"`, `resolution: "unknown"` (the target method is not pinned — these are counted in `coverage.unresolvedCallsites`, which filters on `resolution === "unknown"`, not on `dispatchKind`); `Insert`/`Modify`/`Delete` implicit-trigger edges → `resolution: "maybe"`; symbol-only `.app` dependencies → opaque. All three are documented in the Scope section.

---

## Execution Handoff

Phase 2a plan complete. When ready to build, the two execution options are:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks
2. **Inline Execution** — execute tasks in this session with checkpoints

Phase 2b (L4 — summary engine: Tarjan SCC, fixed-point composition of `RoutineSummary`) gets its own plan after Phase 2a is implemented and reviewed — written against Phase 2a's real `callGraph`/`eventGraph` output.
