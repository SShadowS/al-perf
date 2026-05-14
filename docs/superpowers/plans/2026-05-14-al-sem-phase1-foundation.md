# al-sem Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the new standalone `al-sem` project and build the L0–L2 layers — parsing, source providers, symbol-package reading, and the semantic indexer — so `analyzeWorkspace()` returns a populated `SemanticIndex`.

**Architecture:** Layered pipeline. L0 (`parser`, `symbols`) turns bytes into trees and symbol records. L1 (`providers`) abstracts where AL comes from and builds version identity. L2 (`index`) walks ASTs into a `SemanticIndex` — objects, routines with intraprocedural features, tables/fields/keys. The `model` unit holds all pure types as the shared vocabulary; later phases populate `callGraph`, `eventGraph`, summaries, and findings.

**Tech Stack:** TypeScript, Bun (`bun test`), `web-tree-sitter` + `tree-sitter-al.wasm` V2, Biome for lint/format. No external zip dependency — uses the platform `DecompressionStream` (same approach as al-perf's `src/source/zip-extractor.ts`).

**Reference code (read these — al-perf solves equivalent problems against the same grammar):**
- `U:\Git\al-perf\src\source\parser-init.ts` — tree-sitter WASM init
- `U:\Git\al-perf\src\source\indexer.ts` — AST node-walking for the AL V2 grammar (object/procedure/trigger/loop/record-op extraction). This is the authoritative reference for grammar node type names.
- `U:\Git\al-perf\src\source\zip-extractor.ts` — unzip via `DecompressionStream`, decompression-bomb limits
- `U:\Git\al-perf\src\types\source-index.ts` — al-perf's older flat index types (al-sem's types supersede these)

**Spec:** `docs/superpowers/specs/2026-05-14-al-sem-semantic-engine-design.md` (in the al-perf repo). This plan covers Sections 1, 2, and the L0–L2 parts of Sections 3, 6, 7, 8.

**Naming note:** The spec entity called `Object` is named `ObjectDecl` in code to avoid colliding with the JavaScript global `Object`. All other names match the spec.

**Phase boundary:** Phase 1 produces a `SemanticIndex` (identity + apps + objects + routines with intraprocedural features + tables). It does NOT produce `callGraph`, `eventGraph`, routine `summary` values, `AnalysisCoverage`, or detectors — those are Phase 2 and Phase 3. The `model` types for those are still defined here (they are pure types and form the shared vocabulary), just not populated.

---

## File Structure

```
U:\Git\al-sem\
  package.json
  tsconfig.json
  biome.json
  .gitignore
  README.md
  src/
    hash.ts                    sha256 hashing utility
    model/
      ids.ts                   ID type aliases, CanonicalRoutineKey, encode/decode functions
      identity.ts              SourceRange, SourceAnchor, AppIdentity, ModelIdentity
      entities.ts              App, ObjectDecl, Routine, Table, Field, Key, RecordVariable,
                               OperationSite, RecordOperation, CallSite, LoopNode, FieldAccess,
                               IntraproceduralFeatures, ParameterSymbol, TempState, RecordOpType
      summary.ts               RoutineSummary, DbEffect, ParameterEffectSummary, EffectPresence,
                               Uncertainty   (types only — populated in Phase 2)
      graph.ts                 CallEdge, EventSymbol, EventEdge   (types only — Phase 2)
      finding.ts               Finding, FindingConfidence, EvidenceStep, FixOption, Evidence,
                               Diagnostic   (types only — Phase 3)
      model.ts                 SemanticIndex, SemanticModel, AnalysisCoverage
      index.ts                 barrel re-export of all model types
    parser/
      parser-init.ts           tree-sitter WASM init (ported from al-perf)
      ast.ts                   AST helper functions (node walking, field access, descendant checks)
    symbols/
      symbol-reader.ts         .app zip -> AppIdentity + SymbolPackage records + embedded source
    providers/
      types.ts                 SourceProvider interface, SourceUnit
      workspace.ts             WorkspaceProvider — enumerates workspace .al files
      app-package.ts           AppPackageProvider — enumerates .alpackages/*.app
      external.ts              ExternalSourceProvider — stub (seam for MS source later)
      discover.ts              discoverSources() — combines providers, builds ModelIdentity
    index/
      object-indexer.ts        object declaration -> ObjectDecl + Table/Field/Key
      intraprocedural-ops.ts   extract loops + operation sites + record operations from a body
      intraprocedural-refs.ts  extract call sites + field accesses + record variables from a body
      routine-indexer.ts       extract routines/triggers + attach intraprocedural features
      indexer.ts               orchestrate: SourceUnit[] -> SemanticIndex
    index.ts                   analyzeWorkspace() — Phase 1 entry point
  test/
    fixtures/
      al/                      hand-written .al files, one construct each
      app/                     synthetic .app package(s)
    *.test.ts                  co-located by unit under test/
```

---

## Task 1: Scaffold the al-sem project

**Files:**
- Create: `U:\Git\al-sem\package.json`
- Create: `U:\Git\al-sem\tsconfig.json`
- Create: `U:\Git\al-sem\biome.json`
- Create: `U:\Git\al-sem\.gitignore`
- Create: `U:\Git\al-sem\README.md`
- Create: `U:\Git\al-sem\src\parser\tree-sitter-al.wasm` (copied binary)

- [ ] **Step 1: Create the project directory and initialize git**

Run:
```bash
mkdir -p U:/Git/al-sem/src U:/Git/al-sem/test/fixtures/al U:/Git/al-sem/test/fixtures/app
cd U:/Git/al-sem && git init
```
Expected: `Initialized empty Git repository in U:/Git/al-sem/.git/`

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "al-sem",
  "version": "0.0.1",
  "description": "Static semantic analysis engine for Microsoft Business Central AL code",
  "type": "module",
  "module": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "engines": {
    "bun": ">=1.0.0"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit",
    "lint": "bunx biome check src test",
    "format": "bunx biome format --write src test"
  },
  "dependencies": {
    "web-tree-sitter": "^0.25.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Write `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "lineWidth": 100
  }
}
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
*.log
.DS_Store
dist/
.al-sem-cache/
```

- [ ] **Step 6: Write `README.md`**

```markdown
# al-sem

Static semantic analysis engine for Microsoft Business Central AL code.

Builds a cross-file `SemanticModel` — symbol index, call graph, event graph, routine
summaries — from AL source and `.app` symbol packages. Pure static analysis: no profile
or telemetry knowledge. Consumed as a library by `al-perf`, and usable standalone as a
CLI and MCP server.

See `docs/` in the al-perf repo for the design spec.

## Development

```bash
bun install
bun test
bun run typecheck
```
```

- [ ] **Step 7: Copy the tree-sitter-al WASM grammar**

Run:
```bash
cp U:/Git/al-perf/src/source/tree-sitter-al.wasm U:/Git/al-sem/src/parser/tree-sitter-al.wasm
```
Expected: no output. Verify with `ls -la U:/Git/al-sem/src/parser/tree-sitter-al.wasm` — file exists, non-zero size.

- [ ] **Step 8: Install dependencies**

Run: `cd U:/Git/al-sem && bun install`
Expected: `bun install` completes, creates `bun.lockb` and `node_modules/`.

- [ ] **Step 9: Verify the toolchain**

Run: `cd U:/Git/al-sem && bunx tsc --noEmit`
Expected: no output, exit 0 (no source files yet — this just confirms tsc runs).

- [ ] **Step 10: Commit**

```bash
cd U:/Git/al-sem
git add -A
git commit -m "chore: scaffold al-sem project"
```

---

## Task 2: Hashing utility (`src/hash.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\hash.ts`
- Test: `U:\Git\al-sem\test\hash.test.ts`

- [ ] **Step 1: Write the failing test**

`test/hash.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { sha256Hex, sha256OfStrings } from "../src/hash.ts";

describe("sha256Hex", () => {
	test("produces a stable 64-char hex digest", () => {
		const h = sha256Hex("hello");
		expect(h).toBe(
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		);
		expect(h).toHaveLength(64);
	});

	test("different input produces different digest", () => {
		expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
	});
});

describe("sha256OfStrings", () => {
	test("is order-sensitive and separator-safe", () => {
		// ["ab","c"] must not collide with ["a","bc"]
		expect(sha256OfStrings(["ab", "c"])).not.toBe(sha256OfStrings(["a", "bc"]));
	});

	test("is deterministic", () => {
		expect(sha256OfStrings(["x", "y", "z"])).toBe(sha256OfStrings(["x", "y", "z"]));
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/hash.test.ts`
Expected: FAIL — `Cannot find module '../src/hash.ts'`.

- [ ] **Step 3: Write minimal implementation**

`src/hash.ts`:
```typescript
import { createHash } from "node:crypto";

/** SHA-256 hex digest of a string. */
export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * SHA-256 hex digest of an ordered list of strings.
 * Uses a length-prefixed encoding so concatenation is unambiguous:
 * ["ab","c"] and ["a","bc"] produce different digests.
 */
export function sha256OfStrings(parts: string[]): string {
	const h = createHash("sha256");
	for (const part of parts) {
		h.update(String(part.length));
		h.update(":");
		h.update(part, "utf8");
	}
	return h.digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/hash.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/hash.ts test/hash.test.ts
git commit -m "feat: add sha256 hashing utility"
```

---

## Task 3: ID types and encoding (`src/model/ids.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\model\ids.ts`
- Test: `U:\Git\al-sem\test\model-ids.test.ts`

This defines the two-level identity from spec Section 2: a `CanonicalRoutineKey` stable across
app version bumps, and string ID encoders. ID strings are opaque elsewhere — only this file
constructs and parses them.

- [ ] **Step 1: Write the failing test**

`test/model-ids.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import {
	type CanonicalRoutineKey,
	encodeCanonicalRoutineKey,
	encodeObjectId,
	encodeRoutineId,
	encodeTableId,
} from "../src/model/ids.ts";

const APP_GUID = "11111111-1111-1111-1111-111111111111";

describe("encodeObjectId", () => {
	test("encodes appGuid/objectType/objectNumber", () => {
		expect(encodeObjectId(APP_GUID, "Codeunit", 50100)).toBe(
			`${APP_GUID}/Codeunit/50100`,
		);
	});
});

describe("encodeTableId", () => {
	test("encodes appGuid/table/number", () => {
		expect(encodeTableId(APP_GUID, 18)).toBe(`${APP_GUID}/table/18`);
	});
});

describe("encodeCanonicalRoutineKey", () => {
	test("is deterministic for equal keys", () => {
		const key: CanonicalRoutineKey = {
			appGuid: APP_GUID,
			objectType: "Codeunit",
			objectNumber: 50100,
			routineKind: "procedure",
			routineName: "DoWork",
			normalizedSignatureHash: "abc123",
		};
		expect(encodeCanonicalRoutineKey(key)).toBe(encodeCanonicalRoutineKey({ ...key }));
	});

	test("differs when routineName differs", () => {
		const base: CanonicalRoutineKey = {
			appGuid: APP_GUID,
			objectType: "Codeunit",
			objectNumber: 50100,
			routineKind: "procedure",
			routineName: "DoWork",
			normalizedSignatureHash: "abc123",
		};
		expect(encodeCanonicalRoutineKey(base)).not.toBe(
			encodeCanonicalRoutineKey({ ...base, routineName: "DoOther" }),
		);
	});
});

describe("encodeRoutineId", () => {
	test("combines canonical key and model instance id", () => {
		const key: CanonicalRoutineKey = {
			appGuid: APP_GUID,
			objectType: "Codeunit",
			objectNumber: 50100,
			routineKind: "procedure",
			routineName: "DoWork",
			normalizedSignatureHash: "abc123",
		};
		const id = encodeRoutineId(key, "model-instance-1");
		expect(id).toContain("model-instance-1");
		expect(id).toContain(encodeCanonicalRoutineKey(key));
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/model-ids.test.ts`
Expected: FAIL — `Cannot find module '../src/model/ids.ts'`.

- [ ] **Step 3: Write minimal implementation**

`src/model/ids.ts`:
```typescript
import { sha256OfStrings } from "../hash.ts";

/** Routine kinds — table/page/report triggers are routines, indexed from day one. */
export type RoutineKind =
	| "procedure"
	| "trigger"
	| "event-publisher"
	| "event-subscriber";

// --- ID string aliases. Opaque outside this module. ---
export type ObjectId = string; // "{appGuid}/{objectType}/{objectNumber}"
export type TableId = string; // "{appGuid}/table/{number}"  (physical table)
export type FieldId = string; // "{tableId}/{fieldNumber}"
export type KeyId = string; // "{tableId}/key/{index}"
export type RoutineId = string; // encodes { canonicalKey, modelInstanceId }
export type CallsiteId = string; // "{routineId}/cs{index}"
export type LoopId = string; // "{routineId}/loop{index}"
export type OperationId = string; // "{routineId}/op{index}"
export type RecordVariableId = string; // "{routineId}/rv/{name}"
export type EventId = string; // "{publisherObjectId}/event/{eventName}"

/**
 * Stable across app version bumps when the symbol is semantically the same.
 * This is the key regression comparison (sub-project D) and profile fusion
 * (sub-project B) join on.
 */
export interface CanonicalRoutineKey {
	appGuid: string;
	objectType: string;
	objectNumber: number;
	routineKind: RoutineKind;
	routineName: string;
	normalizedSignatureHash: string;
}

export function encodeObjectId(
	appGuid: string,
	objectType: string,
	objectNumber: number,
): ObjectId {
	return `${appGuid}/${objectType}/${objectNumber}`;
}

export function encodeTableId(appGuid: string, tableNumber: number): TableId {
	return `${appGuid}/table/${tableNumber}`;
}

export function encodeFieldId(tableId: TableId, fieldNumber: number): FieldId {
	return `${tableId}/${fieldNumber}`;
}

export function encodeKeyId(tableId: TableId, keyIndex: number): KeyId {
	return `${tableId}/key/${keyIndex}`;
}

/** Order-sensitive, collision-free hash of the canonical key fields. */
export function encodeCanonicalRoutineKey(key: CanonicalRoutineKey): string {
	return sha256OfStrings([
		key.appGuid,
		key.objectType,
		String(key.objectNumber),
		key.routineKind,
		key.routineName.toLowerCase(),
		key.normalizedSignatureHash,
	]);
}

/** Model-instance-scoped concrete routine identity. */
export function encodeRoutineId(
	key: CanonicalRoutineKey,
	modelInstanceId: string,
): RoutineId {
	return `${modelInstanceId}/${encodeCanonicalRoutineKey(key)}`;
}

export function encodeCallsiteId(routineId: RoutineId, index: number): CallsiteId {
	return `${routineId}/cs${index}`;
}

export function encodeLoopId(routineId: RoutineId, index: number): LoopId {
	return `${routineId}/loop${index}`;
}

export function encodeOperationId(routineId: RoutineId, index: number): OperationId {
	return `${routineId}/op${index}`;
}

export function encodeRecordVariableId(
	routineId: RoutineId,
	variableName: string,
): RecordVariableId {
	return `${routineId}/rv/${variableName.toLowerCase()}`;
}

export function encodeEventId(publisherObjectId: ObjectId, eventName: string): EventId {
	return `${publisherObjectId}/event/${eventName.toLowerCase()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/model-ids.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/model/ids.ts test/model-ids.test.ts
git commit -m "feat: add two-level identity ID types and encoders"
```

---

## Task 4: Identity and entity types (`src/model/identity.ts`, `src/model/entities.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\model\identity.ts`
- Create: `U:\Git\al-sem\src\model\entities.ts`
- Test: `U:\Git\al-sem\test\model-entities.test.ts`

These are pure type declarations — the "test" is that they compile and a structural sample
satisfies them. Types match spec Section 2.

- [ ] **Step 1: Write `src/model/identity.ts`**

```typescript
/** A character range in a source file. */
export interface SourceRange {
	startLine: number; // 0-based
	startColumn: number;
	endLine: number;
	endColumn: number;
}

/**
 * A stable reference to a location in source. The fingerprint hash fields are a SEAM
 * only in Phase 1 — left undefined; computation is deferred to sub-project D.
 */
export interface SourceAnchor {
	sourceUnitId: string;
	range: SourceRange;
	enclosingRoutineId: string;
	syntaxKind: string;
	normalizedTextHash?: string;
	leadingContextHash?: string;
	trailingContextHash?: string;
}

export type SourceKind =
	| "workspace"
	| "app-source"
	| "symbol-only"
	| "external-source";

export interface AppIdentity {
	appGuid: string;
	publisher: string;
	name: string;
	version: string;
	packageHash?: string;
	symbolReferenceHash?: string;
	sourceAggregateHash?: string;
	sourceKind: SourceKind;
}

/** Top-level version identity of one analysis run. Keys the cache. */
export interface ModelIdentity {
	schemaVersion: string;
	analyzerVersion: string;
	grammarVersion: string;
	symbolReaderVersion: string;
	createdAt: string;
	workspace?: { rootHash?: string; appJsonHash?: string };
	primaryApp?: AppIdentity;
	apps: AppIdentity[];
	dependencyGraphHash: string;
	runtime?: { platform?: string; application?: string; runtime?: string };
}
```

- [ ] **Step 2: Write `src/model/entities.ts`**

```typescript
import type {
	CallsiteId,
	CanonicalRoutineKey,
	FieldId,
	KeyId,
	LoopId,
	ObjectId,
	OperationId,
	RecordVariableId,
	RoutineId,
	RoutineKind,
	TableId,
} from "./ids.ts";
import type { SourceAnchor } from "./identity.ts";
import type { RoutineSummary } from "./summary.ts";

export type RecordOpType =
	| "FindSet"
	| "FindFirst"
	| "FindLast"
	| "Find"
	| "Get"
	| "CalcFields"
	| "CalcSums"
	| "Modify"
	| "ModifyAll"
	| "Insert"
	| "Delete"
	| "DeleteAll"
	| "SetLoadFields"
	| "AddLoadFields"
	| "SetRange"
	| "SetFilter"
	| "SetCurrentKey"
	| "Reset"
	| "Copy"
	| "TransferFields"
	| "Validate"
	| "Next"
	| "Count"
	| "CountApprox"
	| "IsEmpty"
	| "LockTable";

/**
 * Whether a record variable is temporary. Can be caller-dependent when the record is a
 * by-var/value parameter — see spec Section 2.
 */
export type TempState =
	| { kind: "known"; value: boolean }
	| { kind: "unknown" }
	| { kind: "parameter-dependent"; parameterIndex: number };

export interface ParameterSymbol {
	index: number;
	name: string;
	typeText: string; // raw type string, e.g. 'Record "Sales Line"'
	isVar: boolean; // passed by reference
	isRecord: boolean;
	tableName?: string; // when isRecord
}

export interface App {
	appGuid: string;
	publisher: string;
	name: string;
	version: string;
}

export interface ObjectDecl {
	id: ObjectId;
	appGuid: string;
	objectType: string; // "Codeunit", "Table", "TableExtension", "Page", ...
	objectNumber: number;
	name: string;
	sourceUnitId: string;
	sourceHash: string;
	sourceAnchor: SourceAnchor;
}

/** FieldClass + ownership. Ownership follows the declaring object (may be a tableextension). */
export interface Field {
	id: FieldId;
	physicalTableId: TableId;
	declaringObjectId: ObjectId;
	declaringAppId: string; // appGuid
	fieldNumber: number;
	name: string;
	fieldClass: "Normal" | "FlowField" | "FlowFilter";
	dataType: string;
	isBlobLike: boolean;
}

export interface Key {
	id: KeyId;
	physicalTableId: TableId;
	declaringObjectId: ObjectId;
	fields: FieldId[];
	sumIndexFields?: FieldId[];
	isEnabled?: boolean | "unknown";
}

export interface Table {
	id: TableId;
	appGuid: string;
	tableNumber: number;
	name: string;
	fields: Field[];
	keys: Key[];
}

export type LoopType = "repeat" | "for" | "foreach" | "while";

export interface LoopNode {
	id: LoopId;
	type: LoopType;
	sourceAnchor: SourceAnchor;
}

export interface CallSite {
	id: CallsiteId;
	operationId: OperationId;
	calleeText: string; // raw callee expression text, e.g. 'EnrichLine' or 'Customer.Get'
	argumentTexts: string[];
	loopStack: LoopId[]; // loops in THIS routine enclosing the call
	sourceAnchor: SourceAnchor;
}

export interface FieldAccess {
	recordVariableName: string;
	fieldName: string;
	sourceAnchor: SourceAnchor;
}

export interface RecordVariable {
	id: RecordVariableId;
	name: string;
	tableName?: string;
	tableId?: TableId; // resolved in Phase 2; undefined in Phase 1
	tempState: TempState;
	isParameter: boolean;
	parameterIndex?: number;
}

export type OperationSiteKind =
	| "record-op"
	| "call"
	| "event-publish"
	| "commit"
	| "lock"
	| "external-call"
	| "dynamic-dispatch";

export interface OperationSite {
	id: OperationId;
	routineId: RoutineId;
	kind: OperationSiteKind;
	sourceAnchor: SourceAnchor;
	loopStack: LoopId[];
}

/** An OperationSite specialized for record operations. */
export interface RecordOperation {
	id: OperationId;
	routineId: RoutineId;
	op: RecordOpType;
	recordVariableName: string;
	recordVariableId?: RecordVariableId;
	tableId?: TableId; // resolved in Phase 2
	tempState: TempState;
	fieldArguments?: string[]; // for SetRange/SetFilter/SetLoadFields/SetCurrentKey
	loopStack: LoopId[];
	sourceAnchor: SourceAnchor;
}

/** Raw intraprocedural extraction for one routine body. */
export interface IntraproceduralFeatures {
	loops: LoopNode[];
	operationSites: OperationSite[];
	recordOperations: RecordOperation[];
	callSites: CallSite[];
	fieldAccesses: FieldAccess[];
	recordVariables: RecordVariable[];
	nestingDepth: number;
}

export interface Routine {
	id: RoutineId;
	canonical: CanonicalRoutineKey;
	objectId: ObjectId;
	name: string;
	kind: RoutineKind;
	parameters: ParameterSymbol[];
	bodyAvailable: boolean; // false = opaque .app symbol
	parseIncomplete: boolean;
	sourceHash: string;
	sourceAnchor: SourceAnchor;
	features: IntraproceduralFeatures;
	summary?: RoutineSummary; // computed in Phase 2
}
```

- [ ] **Step 3: Write the structural test**

`test/model-entities.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import type { ObjectDecl, RecordOperation, Routine } from "../src/model/entities.ts";
import type { ModelIdentity } from "../src/model/identity.ts";

describe("model entity types", () => {
	test("a structurally valid ObjectDecl satisfies the type", () => {
		const obj: ObjectDecl = {
			id: "guid/Codeunit/50100",
			appGuid: "guid",
			objectType: "Codeunit",
			objectNumber: 50100,
			name: "My Codeunit",
			sourceUnitId: "u1",
			sourceHash: "h",
			sourceAnchor: {
				sourceUnitId: "u1",
				range: { startLine: 0, startColumn: 0, endLine: 10, endColumn: 0 },
				enclosingRoutineId: "",
				syntaxKind: "codeunit_declaration",
			},
		};
		expect(obj.objectNumber).toBe(50100);
	});

	test("a RecordOperation carries tri-state temp", () => {
		const op: RecordOperation = {
			id: "r/op0",
			routineId: "r",
			op: "FindSet",
			recordVariableName: "SalesLine",
			tempState: { kind: "parameter-dependent", parameterIndex: 0 },
			loopStack: [],
			sourceAnchor: {
				sourceUnitId: "u1",
				range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 20 },
				enclosingRoutineId: "r",
				syntaxKind: "call_expression",
			},
		};
		expect(op.tempState.kind).toBe("parameter-dependent");
	});

	test("a Routine without a summary is valid (Phase 1)", () => {
		const r: Pick<Routine, "summary"> = {};
		expect(r.summary).toBeUndefined();
	});

	test("ModelIdentity requires apps array", () => {
		const id: ModelIdentity = {
			schemaVersion: "1",
			analyzerVersion: "0.0.1",
			grammarVersion: "v2",
			symbolReaderVersion: "1",
			createdAt: new Date().toISOString(),
			apps: [],
			dependencyGraphHash: "h",
		};
		expect(id.apps).toEqual([]);
	});
});
```

- [ ] **Step 4: Run test + typecheck to verify both pass**

Run: `cd U:/Git/al-sem && bun test test/model-entities.test.ts && bunx tsc --noEmit`
Expected: tests PASS (4 tests). `tsc` reports errors about `./summary.ts` not existing — that
is expected; Task 5 creates it. To make this task self-contained, temporarily skip the
`tsc` check here and run it at the end of Task 5.

Run instead: `cd U:/Git/al-sem && bun test test/model-entities.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/model/identity.ts src/model/entities.ts test/model-entities.test.ts
git commit -m "feat: add identity and entity model types"
```

---

## Task 5: Summary, graph, finding, and model types (`src/model/*`)

**Files:**
- Create: `U:\Git\al-sem\src\model\summary.ts`
- Create: `U:\Git\al-sem\src\model\graph.ts`
- Create: `U:\Git\al-sem\src\model\finding.ts`
- Create: `U:\Git\al-sem\src\model\model.ts`
- Create: `U:\Git\al-sem\src\model\index.ts`
- Test: `U:\Git\al-sem\test\model-shape.test.ts`

Types only — populated in Phase 2 (summary, graph) and Phase 3 (finding). Defined now because
the `model` unit is the shared vocabulary and entities already reference `RoutineSummary`.

- [ ] **Step 1: Write `src/model/summary.ts`**

```typescript
import type {
	CallsiteId,
	FieldId,
	OperationId,
	RoutineId,
	TableId,
} from "./ids.ts";
import type { RecordOpType, TempState } from "./entities.ts";

/** Tri-state effect presence — distinct from "unresolved call". */
export type EffectPresence = "yes" | "no" | "unknown";

export type Uncertainty =
	| { kind: "unresolved-call"; callsiteId: CallsiteId }
	| { kind: "opaque-callee"; callsiteId: CallsiteId }
	| { kind: "dynamic-dispatch"; operationId: OperationId }
	| { kind: "recordref-or-variant"; operationId: OperationId }
	| { kind: "interface-dispatch"; callsiteId: CallsiteId }
	| { kind: "parse-incomplete"; routineId: RoutineId };

/** Compact, de-duped effect fact. Carries NO evidence path — the path-walker rebuilds paths. */
export interface DbEffect {
	effectKey: string; // op + table + operationSite + paramDependency + uncertaintyKind
	operationId: OperationId;
	op: RecordOpType;
	tableId: TableId | "unknown";
	recordVariableId?: string;
	tempState: TempState;
	via: "direct" | "inherited" | "implicit-trigger" | "event-subscriber" | "dynamic";
}

/** Field effects relative to one parameter — required by detector D3. */
export interface ParameterEffectSummary {
	parameterIndex: number;
	tableId: TableId | "unknown";
	readsFields: FieldId[];
	writesFields: FieldId[];
	mayResetFilters: boolean;
	mayChangeLoadFields: boolean;
	mayAssignRecord: boolean;
	mayUseRecordRef: boolean;
}

export interface FieldEffectSet {
	readsByRecordVariable: Record<string, FieldId[]>;
}

export interface RoutineSummary {
	routineId: RoutineId;
	touchesDb: EffectPresence;
	commits: EffectPresence;
	writesTables: TableId[] | "unknown";
	dbEffects: DbEffect[];
	publishesEvents: string[]; // EventId[]
	inRecursiveCycle: boolean;
	hasUnresolvedCalls: boolean;
	uncertainties: Uncertainty[];
	parameterEffects: ParameterEffectSummary[];
	fieldEffects?: FieldEffectSet; // lazy — only when a detector needs it
}
```

- [ ] **Step 2: Write `src/model/graph.ts`**

```typescript
import type {
	CallsiteId,
	EventId,
	ObjectId,
	OperationId,
	RoutineId,
} from "./ids.ts";
import type { ParameterSymbol } from "./entities.ts";

export interface Evidence {
	source: "tree-sitter" | "symbol-package" | "external-source";
	note?: string;
}

export type DispatchKind =
	| "direct"
	| "method"
	| "interface"
	| "codeunit-run"
	| "report-run"
	| "page-run"
	| "event-dispatch"
	| "implicit-trigger"
	| "dynamic"
	| "unresolved";

export type ResolutionQuality = "resolved" | "maybe" | "unknown" | "opaque";

export interface CallEdge {
	from: RoutineId;
	to?: RoutineId; // absent when unresolved
	callsiteId: CallsiteId;
	operationId: OperationId;
	dispatchKind: DispatchKind;
	resolution: ResolutionQuality;
	provenance: Evidence[];
}

export interface EventSymbol {
	id: EventId;
	publisherObjectId: ObjectId;
	publisherRoutineId?: RoutineId;
	eventName: string;
	eventKind: "integration" | "business" | "trigger" | "internal" | "unknown";
	elementName?: string;
	signatureHash: string;
	parameters: ParameterSymbol[];
	provenance: Evidence[];
}

export interface EventEdge {
	eventId: EventId;
	subscriberRoutineId: RoutineId;
	subscriberAppId: string;
	skipOnMissingLicense?: boolean;
	skipOnMissingPermission?: boolean;
	resolution: "resolved" | "maybe" | "unknown";
	provenance: Evidence[];
}
```

- [ ] **Step 3: Write `src/model/finding.ts`**

```typescript
import type {
	CallsiteId,
	LoopId,
	ObjectId,
	OperationId,
	RoutineId,
	TableId,
} from "./ids.ts";
import type { SourceAnchor } from "./identity.ts";
import type { Evidence } from "./graph.ts";

export interface FixOption {
	description: string;
	safety: "high" | "medium" | "low";
}

export interface EvidenceStep {
	routineId: RoutineId;
	operationId?: OperationId;
	callsiteId?: CallsiteId;
	loopId?: LoopId;
	sourceAnchor: SourceAnchor;
	note: string;
}

export interface FindingConfidence {
	level: "confirmed" | "likely" | "possible";
	cappedBy?: (
		| "unresolved-call"
		| "opaque-callee"
		| "dynamic-dispatch"
		| "parse-incomplete"
		| "version-mismatch"
	)[];
	evidence: Evidence[];
}

export interface Finding {
	id: string;
	rootCauseKey: string;
	detector: string;
	title: string;
	rootCause: string;
	severity: "critical" | "high" | "medium" | "low" | "info";
	confidence: FindingConfidence;
	primaryLocation: SourceAnchor;
	evidencePath: EvidenceStep[];
	affectedObjects: ObjectId[];
	affectedTables: TableId[];
	fixOptions: FixOption[];
	provenance: Evidence[];
}

export interface Diagnostic {
	severity: "error" | "warning" | "info";
	stage: "discover" | "parse" | "symbol-read" | "index" | "resolve" | "summarize" | "detect";
	message: string;
	sourceRef?: string;
}
```

- [ ] **Step 4: Write `src/model/model.ts`**

```typescript
import type { App, ObjectDecl, Routine, Table } from "./entities.ts";
import type { CallEdge, EventEdge, EventSymbol } from "./graph.ts";
import type { CallsiteId, OperationId, RoutineId } from "./ids.ts";
import type { ModelIdentity } from "./identity.ts";

/** First-class "no silent clean" coverage record. Populated in Phase 2. */
export interface AnalysisCoverage {
	sourceUnitsTotal: number;
	sourceUnitsParsed: number;
	routinesTotal: number;
	routinesBodyAvailable: number;
	routinesParseIncomplete: RoutineId[];
	opaqueApps: string[];
	unresolvedCallsites: CallsiteId[];
	dynamicDispatchSites: OperationId[];
}

/**
 * The Phase 1 deliverable: identity + apps + objects + routines (with intraprocedural
 * features, no summaries) + tables. No call graph, no event graph.
 */
export interface SemanticIndex {
	identity: ModelIdentity;
	apps: App[];
	objects: ObjectDecl[];
	routines: Routine[];
	tables: Table[];
}

/** The full model — Phase 2 extends a SemanticIndex with graphs and coverage. */
export interface SemanticModel extends SemanticIndex {
	callGraph: CallEdge[];
	eventGraph: { events: EventSymbol[]; edges: EventEdge[] };
	coverage: AnalysisCoverage;
}
```

- [ ] **Step 5: Write `src/model/index.ts` barrel**

```typescript
export * from "./ids.ts";
export * from "./identity.ts";
export * from "./entities.ts";
export * from "./summary.ts";
export * from "./graph.ts";
export * from "./finding.ts";
export * from "./model.ts";
```

- [ ] **Step 6: Write the structural test**

`test/model-shape.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import type { RoutineSummary } from "../src/model/summary.ts";
import type { CallEdge } from "../src/model/graph.ts";
import type { Finding } from "../src/model/finding.ts";
import type { SemanticIndex } from "../src/model/model.ts";

describe("model shape", () => {
	test("a RoutineSummary uses tri-state effects", () => {
		const s: Pick<RoutineSummary, "touchesDb" | "commits"> = {
			touchesDb: "unknown",
			commits: "no",
		};
		expect(s.touchesDb).toBe("unknown");
	});

	test("a CallEdge carries dispatch kind and resolution quality", () => {
		const e: CallEdge = {
			from: "r1",
			callsiteId: "r1/cs0",
			operationId: "r1/op0",
			dispatchKind: "unresolved",
			resolution: "unknown",
			provenance: [{ source: "tree-sitter" }],
		};
		expect(e.to).toBeUndefined();
	});

	test("a Finding's confidence ceiling can be expressed as 'likely'", () => {
		const f: Pick<Finding, "confidence"> = {
			confidence: { level: "likely", evidence: [] },
		};
		expect(f.confidence.level).toBe("likely");
	});

	test("a SemanticIndex has no callGraph field", () => {
		const idx = {} as SemanticIndex;
		// @ts-expect-error — callGraph belongs to SemanticModel, not SemanticIndex
		idx.callGraph;
		expect(true).toBe(true);
	});
});
```

- [ ] **Step 7: Run test + full typecheck**

Run: `cd U:/Git/al-sem && bun test test/model-shape.test.ts && bunx tsc --noEmit`
Expected: tests PASS (4 tests); `tsc` exits 0 with no errors (all model files now resolve).

- [ ] **Step 8: Commit**

```bash
cd U:/Git/al-sem
git add src/model/summary.ts src/model/graph.ts src/model/finding.ts src/model/model.ts src/model/index.ts test/model-shape.test.ts
git commit -m "feat: add summary, graph, finding, and model types"
```

---

## Task 6: tree-sitter parser init (`src/parser/parser-init.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\parser\parser-init.ts`
- Create: `U:\Git\al-sem\test\fixtures\al\simple-codeunit.al`
- Test: `U:\Git\al-sem\test\parser-init.test.ts`

Ported from `U:\Git\al-perf\src\source\parser-init.ts` but with the WASM file shipped in-repo
(no download fallback — al-sem must be self-contained for CI/Docker).

- [ ] **Step 1: Create the test fixture**

`test/fixtures/al/simple-codeunit.al`:
```al
codeunit 50100 "Simple Codeunit"
{
    procedure DoWork()
    var
        Customer: Record Customer;
    begin
        Customer.FindFirst();
    end;
}
```

- [ ] **Step 2: Write the failing test**

`test/parser-init.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseALSource } from "../src/parser/parser-init.ts";

describe("parseALSource", () => {
	test("parses a simple codeunit into a tree with a root node", async () => {
		const source = readFileSync(
			new URL("./fixtures/al/simple-codeunit.al", import.meta.url),
			"utf8",
		);
		const tree = await parseALSource(source);
		expect(tree.rootNode).toBeDefined();
		expect(tree.rootNode.type).toBe("source_file");
		// The codeunit declaration is a named child of the root.
		const kinds = tree.rootNode.namedChildren.map((c) => c.type);
		expect(kinds).toContain("codeunit_declaration");
	});

	test("malformed source still returns a tree (error nodes, no throw)", async () => {
		const tree = await parseALSource("codeunit 50100 {{{ broken");
		expect(tree.rootNode).toBeDefined();
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/parser-init.test.ts`
Expected: FAIL — `Cannot find module '../src/parser/parser-init.ts'`.

- [ ] **Step 4: Write the implementation**

`src/parser/parser-init.ts`:
```typescript
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Tree } from "web-tree-sitter";

let cachedParser: Parser | null = null;

/**
 * Initialize and return a tree-sitter parser configured with the AL V2 grammar.
 * The parser is cached. The WASM grammar ships in-repo at src/parser/tree-sitter-al.wasm —
 * al-sem does not download it (self-contained for CI/Docker).
 */
export async function createALParser(): Promise<Parser> {
	if (cachedParser) return cachedParser;

	await Parser.init();
	const parser = new Parser();

	const thisDir = dirname(fileURLToPath(import.meta.url));
	const wasmPath = resolve(thisDir, "tree-sitter-al.wasm");
	if (!existsSync(wasmPath)) {
		throw new Error(
			`tree-sitter-al.wasm not found at ${wasmPath}. ` +
				`It must be committed to the repo at src/parser/tree-sitter-al.wasm.`,
		);
	}

	const AL = await Language.load(wasmPath);
	parser.setLanguage(AL);

	cachedParser = parser;
	return parser;
}

/** Parse AL source code into a syntax tree. Initializes the parser on first call. */
export async function parseALSource(source: string): Promise<Tree> {
	const parser = await createALParser();
	return parser.parse(source) as Tree;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/parser-init.test.ts`
Expected: PASS — 2 tests pass.

> If `tree.rootNode.type` is not `"source_file"`, inspect the actual root type by adding
> `console.log(tree.rootNode.type)` and adjust the assertion. The AL V2 grammar's root node
> type is authoritative — al-perf's `src/source/indexer.ts` walks `root.namedChildren`
> directly, confirming the root holds object declarations as named children.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/parser/parser-init.ts test/fixtures/al/simple-codeunit.al test/parser-init.test.ts
git commit -m "feat: add tree-sitter AL parser init"
```

---

## Task 7: AST helper functions (`src/parser/ast.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\parser\ast.ts`
- Test: `U:\Git\al-sem\test\ast.test.ts`

Small pure helpers for walking tree-sitter nodes. These wrap node operations the indexer
needs repeatedly. Logic mirrors helpers in `U:\Git\al-perf\src\source\indexer.ts`
(`stripQuotes`, `isDescendantOf`, `computeNestingDepth`, node-collection patterns).

- [ ] **Step 1: Write the failing test**

`test/ast.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { parseALSource } from "../src/parser/parser-init.ts";
import {
	collectDescendants,
	nodeToSourceRange,
	stripQuotes,
} from "../src/parser/ast.ts";

describe("stripQuotes", () => {
	test("removes surrounding double quotes", () => {
		expect(stripQuotes('"Sales Line"')).toBe("Sales Line");
	});
	test("leaves unquoted text unchanged", () => {
		expect(stripQuotes("Customer")).toBe("Customer");
	});
});

describe("nodeToSourceRange", () => {
	test("maps a node's position to a SourceRange", async () => {
		const tree = await parseALSource('codeunit 50100 "C" { }');
		const range = nodeToSourceRange(tree.rootNode);
		expect(range.startLine).toBe(0);
		expect(range.startColumn).toBe(0);
		expect(range.endColumn).toBeGreaterThan(0);
	});
});

describe("collectDescendants", () => {
	test("collects all descendant nodes matching a predicate", async () => {
		const tree = await parseALSource(`
codeunit 50100 "C"
{
    procedure A() begin end;
    procedure B() begin end;
}`);
		const procs = collectDescendants(
			tree.rootNode,
			(n) => n.type === "procedure",
		);
		expect(procs.length).toBe(2);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/ast.test.ts`
Expected: FAIL — `Cannot find module '../src/parser/ast.ts'`.

- [ ] **Step 3: Write the implementation**

`src/parser/ast.ts`:
```typescript
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { SourceRange } from "../model/identity.ts";

/** Strip surrounding double quotes from a quoted_identifier node's text. */
export function stripQuotes(text: string): string {
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
		return text.slice(1, -1);
	}
	return text;
}

/** Map a tree-sitter node's position to a model SourceRange (0-based). */
export function nodeToSourceRange(node: SyntaxNode): SourceRange {
	return {
		startLine: node.startPosition.row,
		startColumn: node.startPosition.column,
		endLine: node.endPosition.row,
		endColumn: node.endPosition.column,
	};
}

/** Depth-first collect every descendant (and the node itself) matching a predicate. */
export function collectDescendants(
	root: SyntaxNode,
	predicate: (node: SyntaxNode) => boolean,
): SyntaxNode[] {
	const out: SyntaxNode[] = [];
	const stack: SyntaxNode[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		if (predicate(node)) out.push(node);
		for (const child of node.namedChildren) {
			if (child) stack.push(child);
		}
	}
	return out;
}

/** True if `node` is a descendant of `ancestor`. */
export function isDescendantOf(node: SyntaxNode, ancestor: SyntaxNode): boolean {
	let current = node.parent;
	while (current) {
		if (current.id === ancestor.id) return true;
		current = current.parent;
	}
	return false;
}

/** Find the first named child matching a predicate, or null. */
export function findChild(
	node: SyntaxNode,
	predicate: (child: SyntaxNode) => boolean,
): SyntaxNode | null {
	for (const child of node.namedChildren) {
		if (child && predicate(child)) return child;
	}
	return null;
}

/** True if a node is a generic V2 `property` node with the given name (case-insensitive). */
export function isPropertyNamed(node: SyntaxNode, name: string): boolean {
	return (
		node.type === "property" &&
		node.childForFieldName("name")?.text?.toLowerCase() === name.toLowerCase()
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/ast.test.ts`
Expected: PASS — 4 tests pass.

> If `collectDescendants` finds 0 procedures, the grammar node type for a procedure is not
> `"procedure"`. Confirm against al-perf's `src/source/indexer.ts` — it uses
> `proc.childForFieldName("name")` on procedure nodes, and the node type it collects is the
> authoritative name. Adjust the test's predicate to match.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/parser/ast.ts test/ast.test.ts
git commit -m "feat: add tree-sitter AST helper functions"
```

---

## Task 8: Symbol package reader (`src/symbols/symbol-reader.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\symbols\symbol-reader.ts`
- Test: `U:\Git\al-sem\test\symbol-reader.test.ts`
- Test fixture: `U:\Git\al-sem\test\fixtures\app\make-fixture.md` (instructions) + a generated `.app`

A `.app` file is a ZIP archive (sometimes prefixed with a binary header — the real ZIP
content starts at the `PK\x03\x04` magic bytes). It contains `NavxManifest.xml` (app identity)
and `SymbolReference.json` (object/table/field/key/method symbols), and may contain `.al`
source files. This task reads identity + a detect-source flag. The detailed symbol-record
parsing of `SymbolReference.json` is Phase 2 (the resolver needs it); Phase 1 only needs
identity and the `hasEmbeddedSource` flag.

> **Before implementing:** Obtain a real `.app` to confirm the exact archive layout. Check
> `U:\Git\al-perf-bc\` or any AL project's `.alpackages\` folder. Extract it (it is a ZIP) and
> inspect `NavxManifest.xml` for the `<App ... Id Publisher Name Version>` attributes. If no
> real `.app` is available, build the synthetic fixture per Step 1.

- [ ] **Step 1: Create a synthetic `.app` fixture**

`test/fixtures/app/make-fixture.md`:
```markdown
# Synthetic .app fixture

`test/fixtures/app/sample.app` is a ZIP archive containing:

- `NavxManifest.xml`:
  ```xml
  <?xml version="1.0" encoding="utf-8"?>
  <Package xmlns="http://schemas.microsoft.com/navx/2015/manifest">
    <App Id="22222222-2222-2222-2222-222222222222"
         Name="Sample Dependency"
         Publisher="Test Publisher"
         Version="1.0.0.0" />
  </Package>
  ```
- `SymbolReference.json`: `{ "AppId": "22222222-2222-2222-2222-222222222222" }`
- `src/sample.al`: `codeunit 60000 "Sample Dep" { }`

Regenerate with:
```bash
cd test/fixtures/app
mkdir -p _build/src
# write the three files into _build/ ...
cd _build && zip -r ../sample.app . && cd .. && rm -rf _build
```
```

Create the fixture now. Run:
```bash
cd U:/Git/al-sem/test/fixtures/app
mkdir -p _build/src
cat > _build/NavxManifest.xml <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/navx/2015/manifest">
  <App Id="22222222-2222-2222-2222-222222222222" Name="Sample Dependency" Publisher="Test Publisher" Version="1.0.0.0" />
</Package>
EOF
echo '{ "AppId": "22222222-2222-2222-2222-222222222222" }' > _build/SymbolReference.json
echo 'codeunit 60000 "Sample Dep" { }' > _build/src/sample.al
cd _build && zip -r ../sample.app . && cd .. && rm -rf _build
```
Expected: `test/fixtures/app/sample.app` exists.

- [ ] **Step 2: Write the failing test**

`test/symbol-reader.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { readSymbolPackage } from "../src/symbols/symbol-reader.ts";

describe("readSymbolPackage", () => {
	test("reads app identity from NavxManifest.xml", async () => {
		const pkg = await readSymbolPackage(
			new URL("./fixtures/app/sample.app", import.meta.url).pathname,
		);
		expect(pkg.identity.appGuid).toBe("22222222-2222-2222-2222-222222222222");
		expect(pkg.identity.name).toBe("Sample Dependency");
		expect(pkg.identity.publisher).toBe("Test Publisher");
		expect(pkg.identity.version).toBe("1.0.0.0");
	});

	test("detects embedded .al source", async () => {
		const pkg = await readSymbolPackage(
			new URL("./fixtures/app/sample.app", import.meta.url).pathname,
		);
		expect(pkg.hasEmbeddedSource).toBe(true);
		expect(pkg.identity.sourceKind).toBe("app-source");
	});

	test("computes a stable packageHash", async () => {
		const path = new URL("./fixtures/app/sample.app", import.meta.url).pathname;
		const a = await readSymbolPackage(path);
		const b = await readSymbolPackage(path);
		expect(a.identity.packageHash).toBe(b.identity.packageHash);
		expect(a.identity.packageHash).toHaveLength(64);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/symbol-reader.test.ts`
Expected: FAIL — `Cannot find module '../src/symbols/symbol-reader.ts'`.

- [ ] **Step 4: Write the implementation**

`src/symbols/symbol-reader.ts`:
```typescript
import { readFileSync } from "node:fs";
import { Unzipped, unzipSync } from "fflate";
import { sha256Hex } from "../hash.ts";
import type { AppIdentity } from "../model/identity.ts";

export interface SymbolPackage {
	identity: AppIdentity;
	hasEmbeddedSource: boolean;
	/** Relative paths of embedded .al files (empty when symbol-only). */
	embeddedSourceFiles: string[];
	/** Raw SymbolReference.json text — parsed in Phase 2 by the resolver. */
	symbolReferenceJson: string | null;
	/** Decoded embedded .al file contents, keyed by relative path. */
	embeddedSource: Record<string, string>;
}

/** BC .app files may carry a binary header before the ZIP. The ZIP starts at PK\x03\x04. */
function stripAppHeader(bytes: Uint8Array): Uint8Array {
	// Find the ZIP local-file-header magic: 0x50 0x4B 0x03 0x04
	for (let i = 0; i < Math.min(bytes.length - 4, 4096); i++) {
		if (
			bytes[i] === 0x50 &&
			bytes[i + 1] === 0x4b &&
			bytes[i + 2] === 0x03 &&
			bytes[i + 3] === 0x04
		) {
			return i === 0 ? bytes : bytes.subarray(i);
		}
	}
	return bytes; // assume it is already a plain ZIP
}

/** Read attribute value from a single XML tag, tolerant of attribute order. */
function readXmlAttr(xml: string, tag: string, attr: string): string {
	const tagMatch = xml.match(new RegExp(`<${tag}\\b[^>]*>`, "i"));
	if (!tagMatch) return "";
	const attrMatch = tagMatch[0].match(new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, "i"));
	return attrMatch?.[1] ?? "";
}

const textDecoder = new TextDecoder("utf-8");

/** Read a .app symbol package: app identity, embedded-source flag, raw symbol JSON. */
export async function readSymbolPackage(appPath: string): Promise<SymbolPackage> {
	const raw = new Uint8Array(readFileSync(appPath));
	const packageHash = sha256Hex(Buffer.from(raw).toString("base64"));
	const zipBytes = stripAppHeader(raw);

	let entries: Unzipped;
	try {
		entries = unzipSync(zipBytes);
	} catch (err) {
		throw new Error(`Failed to unzip .app at ${appPath}: ${(err as Error).message}`);
	}

	// Entry keys may use either path separator; normalize to forward slashes.
	const norm = (k: string) => k.replace(/\\/g, "/");
	const byName = new Map<string, Uint8Array>();
	for (const [k, v] of Object.entries(entries)) byName.set(norm(k).toLowerCase(), v);

	const manifestBytes =
		byName.get("navxmanifest.xml") ?? byName.get("./navxmanifest.xml");
	const manifestXml = manifestBytes ? textDecoder.decode(manifestBytes) : "";

	const appGuid = readXmlAttr(manifestXml, "App", "Id");
	const name = readXmlAttr(manifestXml, "App", "Name");
	const publisher = readXmlAttr(manifestXml, "App", "Publisher");
	const version = readXmlAttr(manifestXml, "App", "Version");

	const embeddedSource: Record<string, string> = {};
	for (const [k, v] of byName) {
		if (k.endsWith(".al")) {
			embeddedSource[k] = textDecoder.decode(v);
		}
	}
	const embeddedSourceFiles = Object.keys(embeddedSource);
	const hasEmbeddedSource = embeddedSourceFiles.length > 0;

	const symbolRefBytes =
		byName.get("symbolreference.json") ?? byName.get("./symbolreference.json");
	const symbolReferenceJson = symbolRefBytes
		? textDecoder.decode(symbolRefBytes)
		: null;

	const identity: AppIdentity = {
		appGuid,
		publisher,
		name,
		version,
		packageHash,
		symbolReferenceHash: symbolReferenceJson ? sha256Hex(symbolReferenceJson) : undefined,
		sourceKind: hasEmbeddedSource ? "app-source" : "symbol-only",
	};

	return {
		identity,
		hasEmbeddedSource,
		embeddedSourceFiles,
		symbolReferenceJson,
		embeddedSource,
	};
}
```

- [ ] **Step 5: Add the `fflate` dependency**

Run: `cd U:/Git/al-sem && bun add fflate`
Expected: `fflate` added to `package.json` dependencies.

> `fflate` is a tiny, zero-dependency, well-established unzip library. It is used here rather
> than the platform `DecompressionStream` because `.app` archives are multi-entry ZIPs and
> need central-directory parsing, which `DecompressionStream` (raw deflate only) does not do.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/symbol-reader.test.ts`
Expected: PASS — 3 tests pass.

> If `appGuid` is empty, the `NavxManifest.xml` tag/attribute names differ from the assumed
> shape. Inspect the extracted manifest from a real `.app` and adjust `readXmlAttr` calls.

- [ ] **Step 7: Commit**

```bash
cd U:/Git/al-sem
git add src/symbols/symbol-reader.ts test/symbol-reader.test.ts test/fixtures/app/ package.json bun.lockb
git commit -m "feat: add .app symbol package reader (identity + embedded source detection)"
```

---

## Task 9: Source provider types (`src/providers/types.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\providers\types.ts`
- Test: `U:\Git\al-sem\test\provider-types.test.ts`

Defines the `SourceProvider` interface and `SourceUnit` — the common shape every provider
yields. A `SourceUnit` is one analyzable AL source (a workspace file, or an embedded `.al`
from a `.app`), or an opaque symbol-only marker.

- [ ] **Step 1: Write `src/providers/types.ts`**

```typescript
import type { AppIdentity } from "../model/identity.ts";

/**
 * One unit of AL input. `kind: "source"` carries `.al` text to parse and index.
 * `kind: "symbol-only"` marks a dependency whose bodies are opaque (no source available).
 */
export interface SourceUnit {
	id: string; // stable per analysis run, e.g. "ws:<relpath>" or "app:<guid>:<relpath>"
	kind: "source" | "symbol-only";
	appGuid: string;
	relativePath: string;
	absolutePath?: string; // present for workspace files
	content?: string; // present when kind === "source"
	sourceProvider: "workspace" | "app-package" | "external-source";
}

export interface ProviderResult {
	units: SourceUnit[];
	apps: AppIdentity[];
	diagnostics: ProviderDiagnostic[];
}

export interface ProviderDiagnostic {
	severity: "error" | "warning" | "info";
	message: string;
	sourceRef?: string;
}

/** A source of AL input. Each implementation knows one origin of AL. */
export interface SourceProvider {
	readonly name: "workspace" | "app-package" | "external-source";
	/** Enumerate all source units this provider can offer for the given root. */
	collect(rootPath: string): Promise<ProviderResult>;
}
```

- [ ] **Step 2: Write the structural test**

`test/provider-types.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import type { SourceProvider, SourceUnit } from "../src/providers/types.ts";

describe("provider types", () => {
	test("a SourceUnit can be a source unit with content", () => {
		const u: SourceUnit = {
			id: "ws:foo.al",
			kind: "source",
			appGuid: "guid",
			relativePath: "foo.al",
			absolutePath: "/abs/foo.al",
			content: "codeunit 1 X {}",
			sourceProvider: "workspace",
		};
		expect(u.kind).toBe("source");
	});

	test("a SourceUnit can be symbol-only with no content", () => {
		const u: SourceUnit = {
			id: "app:guid:bar.al",
			kind: "symbol-only",
			appGuid: "guid",
			relativePath: "bar.al",
			sourceProvider: "app-package",
		};
		expect(u.content).toBeUndefined();
	});

	test("a SourceProvider implementation satisfies the interface", () => {
		const p: SourceProvider = {
			name: "external-source",
			async collect() {
				return { units: [], apps: [], diagnostics: [] };
			},
		};
		expect(p.name).toBe("external-source");
	});
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/provider-types.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 4: Commit**

```bash
cd U:/Git/al-sem
git add src/providers/types.ts test/provider-types.test.ts
git commit -m "feat: add source provider interface and SourceUnit types"
```

---

## Task 10: Workspace provider (`src/providers/workspace.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\providers\workspace.ts`
- Test: `U:\Git\al-sem\test\workspace-provider.test.ts`
- Test fixtures: `U:\Git\al-sem\test\fixtures\ws\` (a tiny AL workspace)

The `WorkspaceProvider` enumerates `.al` files under a root and reads `app.json` for the
workspace app's identity.

- [ ] **Step 1: Create workspace test fixtures**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p ws/src
cat > ws/app.json <<'EOF'
{
  "id": "33333333-3333-3333-3333-333333333333",
  "name": "Test Workspace App",
  "publisher": "WS Publisher",
  "version": "2.5.0.0"
}
EOF
cat > ws/src/codeunit-a.al <<'EOF'
codeunit 50100 "CU A"
{
    procedure Run() begin end;
}
EOF
cat > ws/src/codeunit-b.al <<'EOF'
codeunit 50101 "CU B"
{
    procedure Run() begin end;
}
EOF
```
Expected: `test/fixtures/ws/app.json` and two `.al` files exist.

- [ ] **Step 2: Write the failing test**

`test/workspace-provider.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { WorkspaceProvider } from "../src/providers/workspace.ts";

const WS_ROOT = new URL("./fixtures/ws", import.meta.url).pathname;

describe("WorkspaceProvider", () => {
	test("enumerates all .al files under the root", async () => {
		const result = await new WorkspaceProvider().collect(WS_ROOT);
		const paths = result.units.map((u) => u.relativePath).sort();
		expect(paths).toEqual(["src/codeunit-a.al", "src/codeunit-b.al"]);
		expect(result.units.every((u) => u.kind === "source")).toBe(true);
		expect(result.units.every((u) => typeof u.content === "string")).toBe(true);
	});

	test("reads app identity from app.json", async () => {
		const result = await new WorkspaceProvider().collect(WS_ROOT);
		expect(result.apps).toHaveLength(1);
		const app = result.apps[0]!;
		expect(app.appGuid).toBe("33333333-3333-3333-3333-333333333333");
		expect(app.name).toBe("Test Workspace App");
		expect(app.sourceKind).toBe("workspace");
	});

	test("tags every unit with the workspace appGuid", async () => {
		const result = await new WorkspaceProvider().collect(WS_ROOT);
		expect(
			result.units.every(
				(u) => u.appGuid === "33333333-3333-3333-3333-333333333333",
			),
		).toBe(true);
	});

	test("emits a diagnostic when app.json is missing", async () => {
		const result = await new WorkspaceProvider().collect(
			new URL("./fixtures/al", import.meta.url).pathname,
		);
		expect(result.diagnostics.some((d) => d.message.includes("app.json"))).toBe(
			true,
		);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/workspace-provider.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/workspace.ts'`.

- [ ] **Step 4: Write the implementation**

`src/providers/workspace.ts`:
```typescript
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { sha256Hex } from "../hash.ts";
import type { AppIdentity } from "../model/identity.ts";
import type {
	ProviderDiagnostic,
	ProviderResult,
	SourceProvider,
	SourceUnit,
} from "./types.ts";

/** Recursively list files under a directory, skipping node_modules and dot-dirs. */
async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			out.push(...(await walk(full)));
		} else {
			out.push(full);
		}
	}
	return out;
}

/** Enumerates .al files in a workspace directory and reads its app.json identity. */
export class WorkspaceProvider implements SourceProvider {
	readonly name = "workspace" as const;

	async collect(rootPath: string): Promise<ProviderResult> {
		const diagnostics: ProviderDiagnostic[] = [];

		// --- app.json identity ---
		let appGuid = "unknown";
		let appName = "unknown";
		let appPublisher = "unknown";
		let appVersion = "0.0.0.0";
		let appJsonRaw: string | null = null;
		try {
			appJsonRaw = readFileSync(join(rootPath, "app.json"), "utf8");
			const appJson = JSON.parse(appJsonRaw) as {
				id?: string;
				name?: string;
				publisher?: string;
				version?: string;
			};
			appGuid = appJson.id ?? appGuid;
			appName = appJson.name ?? appName;
			appPublisher = appJson.publisher ?? appPublisher;
			appVersion = appJson.version ?? appVersion;
		} catch {
			diagnostics.push({
				severity: "warning",
				message: `No readable app.json at ${rootPath} — workspace app identity unknown`,
				sourceRef: rootPath,
			});
		}

		// --- enumerate .al files ---
		const allFiles = await walk(rootPath);
		const units: SourceUnit[] = [];
		const contents: string[] = [];
		for (const absPath of allFiles) {
			if (!absPath.toLowerCase().endsWith(".al")) continue;
			let content: string;
			try {
				content = readFileSync(absPath, "utf8");
			} catch (err) {
				diagnostics.push({
					severity: "warning",
					message: `Could not read ${absPath}: ${(err as Error).message}`,
					sourceRef: absPath,
				});
				continue;
			}
			const relativePath = relative(rootPath, absPath).split(sep).join("/");
			units.push({
				id: `ws:${relativePath}`,
				kind: "source",
				appGuid,
				relativePath,
				absolutePath: absPath,
				content,
				sourceProvider: "workspace",
			});
			contents.push(content);
		}

		const identity: AppIdentity = {
			appGuid,
			publisher: appPublisher,
			name: appName,
			version: appVersion,
			sourceAggregateHash: sha256Hex(contents.sort().join(" ")),
			sourceKind: "workspace",
		};

		return { units, apps: [identity], diagnostics };
	}
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/workspace-provider.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/providers/workspace.ts test/workspace-provider.test.ts test/fixtures/ws/
git commit -m "feat: add workspace source provider"
```

---

## Task 11: App-package provider (`src/providers/app-package.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\providers\app-package.ts`
- Test: `U:\Git\al-sem\test\app-package-provider.test.ts`

The `AppPackageProvider` enumerates `.app` files under a directory (typically `.alpackages/`),
reads each via the symbol reader, and yields `SourceUnit`s — `source` units for `.app`s with
embedded source, a single `symbol-only` marker unit for those without.

- [ ] **Step 1: Create an `.alpackages` fixture directory**

Run:
```bash
cd U:/Git/al-sem/test/fixtures
mkdir -p alpackages
cp app/sample.app alpackages/sample.app
```
Expected: `test/fixtures/alpackages/sample.app` exists (the source-bearing fixture from Task 8).

- [ ] **Step 2: Write the failing test**

`test/app-package-provider.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { AppPackageProvider } from "../src/providers/app-package.ts";

const ALPACKAGES = new URL("./fixtures/alpackages", import.meta.url).pathname;

describe("AppPackageProvider", () => {
	test("reads identity from every .app in the directory", async () => {
		const result = await new AppPackageProvider().collect(ALPACKAGES);
		expect(result.apps).toHaveLength(1);
		expect(result.apps[0]!.appGuid).toBe(
			"22222222-2222-2222-2222-222222222222",
		);
	});

	test("yields source units for an .app with embedded source", async () => {
		const result = await new AppPackageProvider().collect(ALPACKAGES);
		const sourceUnits = result.units.filter((u) => u.kind === "source");
		expect(sourceUnits.length).toBeGreaterThan(0);
		expect(
			sourceUnits.every(
				(u) => u.appGuid === "22222222-2222-2222-2222-222222222222",
			),
		).toBe(true);
		expect(sourceUnits.every((u) => typeof u.content === "string")).toBe(true);
	});

	test("returns empty cleanly when the directory does not exist", async () => {
		const result = await new AppPackageProvider().collect(
			"/no/such/alpackages/dir",
		);
		expect(result.units).toEqual([]);
		expect(result.apps).toEqual([]);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/app-package-provider.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/app-package.ts'`.

- [ ] **Step 4: Write the implementation**

`src/providers/app-package.ts`:
```typescript
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readSymbolPackage } from "../symbols/symbol-reader.ts";
import type {
	ProviderDiagnostic,
	ProviderResult,
	SourceProvider,
	SourceUnit,
} from "./types.ts";

/** Enumerates .app symbol packages under a directory (typically .alpackages/). */
export class AppPackageProvider implements SourceProvider {
	readonly name = "app-package" as const;

	async collect(rootPath: string): Promise<ProviderResult> {
		const diagnostics: ProviderDiagnostic[] = [];
		const units: SourceUnit[] = [];
		const apps: ProviderResult["apps"] = [];

		if (!existsSync(rootPath)) {
			return { units, apps, diagnostics };
		}

		let entries: string[];
		try {
			entries = await readdir(rootPath);
		} catch (err) {
			diagnostics.push({
				severity: "warning",
				message: `Could not read package directory ${rootPath}: ${(err as Error).message}`,
				sourceRef: rootPath,
			});
			return { units, apps, diagnostics };
		}

		for (const entry of entries) {
			if (!entry.toLowerCase().endsWith(".app")) continue;
			const appPath = join(rootPath, entry);
			try {
				const pkg = await readSymbolPackage(appPath);
				apps.push(pkg.identity);

				if (pkg.hasEmbeddedSource) {
					for (const [relPath, content] of Object.entries(pkg.embeddedSource)) {
						units.push({
							id: `app:${pkg.identity.appGuid}:${relPath}`,
							kind: "source",
							appGuid: pkg.identity.appGuid,
							relativePath: relPath,
							content,
							sourceProvider: "app-package",
						});
					}
				} else {
					// Symbol-only: a single marker unit. Phase 2's resolver parses
					// SymbolReference.json for signatures; bodies stay opaque.
					units.push({
						id: `app:${pkg.identity.appGuid}:__symbols__`,
						kind: "symbol-only",
						appGuid: pkg.identity.appGuid,
						relativePath: "__symbols__",
						sourceProvider: "app-package",
					});
				}
			} catch (err) {
				diagnostics.push({
					severity: "warning",
					message: `Skipped corrupt or unreadable .app ${appPath}: ${(err as Error).message}`,
					sourceRef: appPath,
				});
			}
		}

		return { units, apps, diagnostics };
	}
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/app-package-provider.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/providers/app-package.ts test/app-package-provider.test.ts test/fixtures/alpackages/
git commit -m "feat: add .app package source provider"
```

---

## Task 12: External source provider stub (`src/providers/external.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\providers\external.ts`
- Test: `U:\Git\al-sem\test\external-provider.test.ts`

The seam for feeding in Microsoft AL source later (e.g. StefanMaron's
MSDyn365BC.Code.History). Phase 1 ships the stub: it satisfies the `SourceProvider` interface
and returns empty, but accepts an optional pre-supplied map of source files so a future
downloader (or a test) can inject content without changing call sites.

- [ ] **Step 1: Write the failing test**

`test/external-provider.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { ExternalSourceProvider } from "../src/providers/external.ts";

describe("ExternalSourceProvider", () => {
	test("returns empty cleanly with no injected source", async () => {
		const result = await new ExternalSourceProvider().collect("/anything");
		expect(result.units).toEqual([]);
		expect(result.apps).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});

	test("yields injected source units when pre-supplied", async () => {
		const provider = new ExternalSourceProvider({
			appGuid: "44444444-4444-4444-4444-444444444444",
			files: { "base/cust.al": "codeunit 1 X {}" },
		});
		const result = await provider.collect("/anything");
		expect(result.units).toHaveLength(1);
		expect(result.units[0]!.kind).toBe("source");
		expect(result.units[0]!.sourceProvider).toBe("external-source");
		expect(result.units[0]!.content).toBe("codeunit 1 X {}");
		expect(result.apps[0]!.sourceKind).toBe("external-source");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/external-provider.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/external.ts'`.

- [ ] **Step 3: Write the implementation**

`src/providers/external.ts`:
```typescript
import type { AppIdentity } from "../model/identity.ts";
import type { ProviderResult, SourceProvider, SourceUnit } from "./types.ts";

export interface ExternalSourceInjection {
	appGuid: string;
	publisher?: string;
	name?: string;
	version?: string;
	/** Relative path -> .al content. */
	files: Record<string, string>;
}

/**
 * Seam for external AL source (e.g. Microsoft base-app source from a downloaded history
 * repo). Phase 1 is a stub: no downloader is built. Source can be injected directly,
 * which is how a future downloader — or a test — feeds it in without changing callers.
 */
export class ExternalSourceProvider implements SourceProvider {
	readonly name = "external-source" as const;

	constructor(private readonly injection?: ExternalSourceInjection) {}

	async collect(_rootPath: string): Promise<ProviderResult> {
		if (!this.injection) {
			return { units: [], apps: [], diagnostics: [] };
		}

		const { appGuid, publisher, name, version, files } = this.injection;
		const units: SourceUnit[] = Object.entries(files).map(
			([relativePath, content]) => ({
				id: `ext:${appGuid}:${relativePath}`,
				kind: "source",
				appGuid,
				relativePath,
				content,
				sourceProvider: "external-source",
			}),
		);
		const identity: AppIdentity = {
			appGuid,
			publisher: publisher ?? "unknown",
			name: name ?? "unknown",
			version: version ?? "0.0.0.0",
			sourceKind: "external-source",
		};
		return { units, apps: [identity], diagnostics: [] };
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/external-provider.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/providers/external.ts test/external-provider.test.ts
git commit -m "feat: add external source provider stub (seam for MS source)"
```

---

## Task 13: Source discovery + ModelIdentity (`src/providers/discover.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\providers\discover.ts`
- Test: `U:\Git\al-sem\test\discover.test.ts`

`discoverSources()` runs the workspace + app-package providers (and optionally an injected
external provider), merges their results, and builds the top-level `ModelIdentity` —
including the `modelInstanceId` that scopes every `RoutineId` in this run.

- [ ] **Step 1: Write the failing test**

`test/discover.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { discoverSources } from "../src/providers/discover.ts";

const WS_ROOT = new URL("./fixtures/ws", import.meta.url).pathname;
const ALPACKAGES = new URL("./fixtures/alpackages", import.meta.url).pathname;

describe("discoverSources", () => {
	test("merges workspace and app-package units", async () => {
		const result = await discoverSources({
			workspaceRoot: WS_ROOT,
			alpackagesDir: ALPACKAGES,
		});
		const providers = new Set(result.units.map((u) => u.sourceProvider));
		expect(providers.has("workspace")).toBe(true);
		expect(providers.has("app-package")).toBe(true);
	});

	test("builds a ModelIdentity with all discovered apps", async () => {
		const result = await discoverSources({
			workspaceRoot: WS_ROOT,
			alpackagesDir: ALPACKAGES,
		});
		const guids = result.identity.apps.map((a) => a.appGuid).sort();
		expect(guids).toContain("33333333-3333-3333-3333-333333333333");
		expect(guids).toContain("22222222-2222-2222-2222-222222222222");
	});

	test("sets the workspace app as primaryApp", async () => {
		const result = await discoverSources({
			workspaceRoot: WS_ROOT,
			alpackagesDir: ALPACKAGES,
		});
		expect(result.identity.primaryApp?.appGuid).toBe(
			"33333333-3333-3333-3333-333333333333",
		);
	});

	test("modelInstanceId is stable for identical inputs", async () => {
		const a = await discoverSources({ workspaceRoot: WS_ROOT, alpackagesDir: ALPACKAGES });
		const b = await discoverSources({ workspaceRoot: WS_ROOT, alpackagesDir: ALPACKAGES });
		expect(a.modelInstanceId).toBe(b.modelInstanceId);
	});

	test("works with no alpackages directory", async () => {
		const result = await discoverSources({ workspaceRoot: WS_ROOT });
		expect(result.units.some((u) => u.sourceProvider === "workspace")).toBe(true);
		expect(result.identity.apps).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/discover.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/discover.ts'`.

- [ ] **Step 3: Write the implementation**

`src/providers/discover.ts`:
```typescript
import { sha256Hex, sha256OfStrings } from "../hash.ts";
import type { AppIdentity, ModelIdentity } from "../model/identity.ts";
import { AppPackageProvider } from "./app-package.ts";
import type { ExternalSourceProvider } from "./external.ts";
import type { ProviderDiagnostic, SourceUnit } from "./types.ts";
import { WorkspaceProvider } from "./workspace.ts";

/** al-sem schema/version constants. Bump SCHEMA_VERSION when the serialized model changes. */
export const SCHEMA_VERSION = "1";
export const ANALYZER_VERSION = "0.0.1";
export const GRAMMAR_VERSION = "tree-sitter-al-v2";
export const SYMBOL_READER_VERSION = "1";

export interface DiscoverOptions {
	workspaceRoot: string;
	alpackagesDir?: string;
	externalProvider?: ExternalSourceProvider;
}

export interface DiscoverResult {
	units: SourceUnit[];
	identity: ModelIdentity;
	modelInstanceId: string;
	diagnostics: ProviderDiagnostic[];
}

/** Merge AppIdentity records by appGuid; first occurrence wins for source-bearing fields. */
function mergeApps(lists: AppIdentity[][]): AppIdentity[] {
	const byGuid = new Map<string, AppIdentity>();
	for (const list of lists) {
		for (const app of list) {
			if (!byGuid.has(app.appGuid)) byGuid.set(app.appGuid, app);
		}
	}
	return [...byGuid.values()];
}

/**
 * Run all source providers, merge results, and build the ModelIdentity. The
 * modelInstanceId is derived from the discovered apps + unit ids so it is stable for
 * identical inputs and changes when inputs change.
 */
export async function discoverSources(
	options: DiscoverOptions,
): Promise<DiscoverResult> {
	const { workspaceRoot, alpackagesDir, externalProvider } = options;
	const diagnostics: ProviderDiagnostic[] = [];

	const wsResult = await new WorkspaceProvider().collect(workspaceRoot);
	diagnostics.push(...wsResult.diagnostics);

	const appResult = alpackagesDir
		? await new AppPackageProvider().collect(alpackagesDir)
		: { units: [], apps: [], diagnostics: [] };
	diagnostics.push(...appResult.diagnostics);

	const extResult = externalProvider
		? await externalProvider.collect(workspaceRoot)
		: { units: [], apps: [], diagnostics: [] };
	diagnostics.push(...extResult.diagnostics);

	const units = [...wsResult.units, ...appResult.units, ...extResult.units];
	const apps = mergeApps([wsResult.apps, appResult.apps, extResult.apps]);

	// Workspace app is the primary app.
	const primaryApp = wsResult.apps[0];

	const dependencyGraphHash = sha256OfStrings(
		apps.map((a) => `${a.appGuid}@${a.version}`).sort(),
	);

	const modelInstanceId = sha256OfStrings(
		[
			dependencyGraphHash,
			...units.map((u) => u.id).sort(),
		],
	).slice(0, 16);

	const identity: ModelIdentity = {
		schemaVersion: SCHEMA_VERSION,
		analyzerVersion: ANALYZER_VERSION,
		grammarVersion: GRAMMAR_VERSION,
		symbolReaderVersion: SYMBOL_READER_VERSION,
		createdAt: new Date(0).toISOString(), // fixed for determinism; callers may override
		workspace: {
			rootHash: sha256Hex(workspaceRoot),
		},
		primaryApp,
		apps,
		dependencyGraphHash,
	};

	return { units, identity, modelInstanceId, diagnostics };
}
```

> Note: `createdAt` is fixed to the epoch for deterministic test output. The `analyzeWorkspace`
> entry point (Task 19) overwrites it with the real timestamp unless a deterministic-output
> option is set. This keeps the determinism test in Task 19 honest.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/discover.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/providers/discover.ts test/discover.test.ts
git commit -m "feat: add source discovery and ModelIdentity construction"
```

---

## Task 14: Object indexer (`src/index/object-indexer.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\index\object-indexer.ts`
- Test: `U:\Git\al-sem\test\object-indexer.test.ts`
- Test fixtures: `U:\Git\al-sem\test\fixtures\al\table-item.al`

Turns one parsed AL object declaration into an `ObjectDecl`, and — for tables and
tableextensions — into a `Table` with `Field` and `Key` records carrying declaring-app
ownership.

> **Grammar reference:** `U:\Git\al-perf\src\source\indexer.ts` lines 69-227 show the V2 node
> types: object declarations are `*_declaration` named children of the root; the object id is
> the first `integer` child; the name is an `identifier` or `quoted_identifier` child. Fields
> live in a `field` node group; keys in `key` nodes; properties are generic `property` nodes
> (use `isPropertyNamed` from `src/parser/ast.ts`). Confirm exact field/key node type names
> against al-perf's indexer or by logging `node.type` while iterating.

- [ ] **Step 1: Create the table fixture**

`test/fixtures/al/table-item.al`:
```al
table 50200 "Test Item"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Description; Text[100]) { }
        field(3; Inventory; Decimal)
        {
            FieldClass = FlowField;
        }
        field(4; Picture; Blob) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
        key(ByDescription; Description) { }
    }
}
```

- [ ] **Step 2: Write the failing test**

`test/object-indexer.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseALSource } from "../src/parser/parser-init.ts";
import { indexObject } from "../src/index/object-indexer.ts";

const APP_GUID = "33333333-3333-3333-3333-333333333333";

async function indexFixture(file: string) {
	const source = readFileSync(
		new URL(`./fixtures/al/${file}`, import.meta.url),
		"utf8",
	);
	const tree = await parseALSource(source);
	return indexObject({
		tree,
		appGuid: APP_GUID,
		sourceUnitId: `ws:${file}`,
		modelInstanceId: "mi1",
		sourceHash: "hash",
	});
}

describe("indexObject", () => {
	test("extracts an ObjectDecl for a codeunit", async () => {
		const result = await indexFixture("simple-codeunit.al");
		expect(result.object?.objectType).toBe("Codeunit");
		expect(result.object?.objectNumber).toBe(50100);
		expect(result.object?.name).toBe("Simple Codeunit");
		expect(result.table).toBeUndefined();
	});

	test("extracts a Table with fields and keys", async () => {
		const result = await indexFixture("table-item.al");
		expect(result.object?.objectType).toBe("Table");
		const table = result.table!;
		expect(table.tableNumber).toBe(50200);
		expect(table.fields.map((f) => f.name)).toEqual([
			"No.",
			"Description",
			"Inventory",
			"Picture",
		]);
	});

	test("marks FlowField and Blob-like fields", async () => {
		const result = await indexFixture("table-item.al");
		const fields = result.table!.fields;
		expect(fields.find((f) => f.name === "Inventory")?.fieldClass).toBe(
			"FlowField",
		);
		expect(fields.find((f) => f.name === "Picture")?.isBlobLike).toBe(true);
		expect(fields.find((f) => f.name === "No.")?.fieldClass).toBe("Normal");
	});

	test("records declaring-app ownership on fields and keys", async () => {
		const result = await indexFixture("table-item.al");
		const table = result.table!;
		expect(table.fields.every((f) => f.declaringAppId === APP_GUID)).toBe(true);
		expect(table.keys.length).toBe(2);
		expect(table.keys[0]!.fields.length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/object-indexer.test.ts`
Expected: FAIL — `Cannot find module '../src/index/object-indexer.ts'`.

- [ ] **Step 4: Write the implementation**

`src/index/object-indexer.ts`:
```typescript
import type { Node as SyntaxNode, Tree } from "web-tree-sitter";
import { findChild, isPropertyNamed, nodeToSourceRange, stripQuotes } from "../parser/ast.ts";
import type { Field, Key, ObjectDecl, Table } from "../model/entities.ts";
import {
	encodeFieldId,
	encodeKeyId,
	encodeObjectId,
	encodeTableId,
} from "../model/ids.ts";

/** Maps V2 grammar object declaration node types to display object-type names. */
const OBJECT_TYPE_MAP: Record<string, string> = {
	codeunit_declaration: "Codeunit",
	table_declaration: "Table",
	tableextension_declaration: "TableExtension",
	page_declaration: "Page",
	pageextension_declaration: "PageExtension",
	report_declaration: "Report",
	reportextension_declaration: "ReportExtension",
	query_declaration: "Query",
	xmlport_declaration: "XMLport",
	enum_declaration: "Enum",
	enumextension_declaration: "EnumExtension",
	interface_declaration: "Interface",
	controladdin_declaration: "ControlAddIn",
	permissionset_declaration: "PermissionSet",
};

export interface IndexObjectInput {
	tree: Tree;
	appGuid: string;
	sourceUnitId: string;
	modelInstanceId: string;
	sourceHash: string;
}

export interface IndexObjectResult {
	object?: ObjectDecl;
	/** The object declaration node, for the routine indexer to walk further. */
	objectNode?: SyntaxNode;
	objectType?: string;
	/** Present for table and tableextension declarations. */
	table?: Table;
}

function findObjectDeclaration(root: SyntaxNode): SyntaxNode | null {
	for (const child of root.namedChildren) {
		if (child && child.type in OBJECT_TYPE_MAP) return child;
	}
	return null;
}

function extractObjectNumber(decl: SyntaxNode): number {
	for (const child of decl.namedChildren) {
		if (child?.type === "integer") return parseInt(child.text, 10);
	}
	return 0;
}

function extractObjectName(decl: SyntaxNode): string {
	for (const child of decl.namedChildren) {
		if (child?.type === "quoted_identifier") return stripQuotes(child.text);
		if (child?.type === "identifier") return child.text;
	}
	return "";
}

const BLOB_LIKE = new Set(["blob", "media", "mediaset"]);

/** Extract a field's data type text and FlowField/Blob classification. */
function classifyField(fieldNode: SyntaxNode): {
	dataType: string;
	fieldClass: Field["fieldClass"];
	isBlobLike: boolean;
} {
	// The type is the last identifier-ish child of the field node before the property list.
	// FieldClass lives in a generic `property` node named "FieldClass".
	let dataType = "";
	for (const child of fieldNode.namedChildren) {
		if (
			child &&
			(child.type === "identifier" ||
				child.type === "quoted_identifier" ||
				child.type.endsWith("_type") ||
				child.type === "type_specification")
		) {
			dataType = child.text;
		}
	}
	let fieldClass: Field["fieldClass"] = "Normal";
	const propList = findChild(fieldNode, (c) => c.type.includes("property_list"));
	const propsScope = propList ?? fieldNode;
	for (const child of propsScope.namedChildren) {
		if (child && isPropertyNamed(child, "FieldClass")) {
			const value = child.childForFieldName("value")?.text ?? "";
			if (/flowfield/i.test(value)) fieldClass = "FlowField";
			else if (/flowfilter/i.test(value)) fieldClass = "FlowFilter";
		}
	}
	const isBlobLike = BLOB_LIKE.has(dataType.toLowerCase());
	return { dataType, fieldClass, isBlobLike };
}

/** Build a Table (with Fields and Keys) from a table/tableextension declaration node. */
function indexTable(
	decl: SyntaxNode,
	objectId: string,
	appGuid: string,
	tableNumber: number,
	tableName: string,
): Table {
	const tableId = encodeTableId(appGuid, tableNumber);
	const fields: Field[] = [];
	const keys: Key[] = [];

	// Collect `field(...)` nodes anywhere under the declaration.
	const fieldNodes: SyntaxNode[] = [];
	const keyNodes: SyntaxNode[] = [];
	const stack: SyntaxNode[] = [decl];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		if (node.type === "field") fieldNodes.push(node);
		if (node.type === "key") keyNodes.push(node);
		for (const child of node.namedChildren) if (child) stack.push(child);
	}

	for (const fieldNode of fieldNodes) {
		// field(<number>; <name>; <type>) — number is first integer, name is next ident.
		let fieldNumber = 0;
		let fieldName = "";
		for (const child of fieldNode.namedChildren) {
			if (!child) continue;
			if (fieldNumber === 0 && child.type === "integer") {
				fieldNumber = parseInt(child.text, 10);
				continue;
			}
			if (
				fieldName === "" &&
				(child.type === "identifier" || child.type === "quoted_identifier")
			) {
				fieldName = stripQuotes(child.text);
				continue;
			}
		}
		const { dataType, fieldClass, isBlobLike } = classifyField(fieldNode);
		fields.push({
			id: encodeFieldId(tableId, fieldNumber),
			physicalTableId: tableId,
			declaringObjectId: objectId,
			declaringAppId: appGuid,
			fieldNumber,
			name: fieldName,
			fieldClass,
			dataType,
			isBlobLike,
		});
	}

	const fieldsByName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
	keyNodes.forEach((keyNode, index) => {
		// key(<name>; <field>, <field>, ...)
		const keyFieldIds: string[] = [];
		for (const child of keyNode.namedChildren) {
			if (!child) continue;
			if (child.type === "identifier" || child.type === "quoted_identifier") {
				const f = fieldsByName.get(stripQuotes(child.text).toLowerCase());
				if (f) keyFieldIds.push(f.id);
			}
		}
		keys.push({
			id: encodeKeyId(tableId, index),
			physicalTableId: tableId,
			declaringObjectId: objectId,
			fields: keyFieldIds,
		});
	});

	return { id: tableId, appGuid, tableNumber, name: tableName, fields, keys };
}

/** Index the single object declaration in a parsed source file. */
export function indexObject(input: IndexObjectInput): IndexObjectResult {
	const { tree, appGuid, sourceUnitId, sourceHash } = input;
	const decl = findObjectDeclaration(tree.rootNode);
	if (!decl) return {};

	const objectType = OBJECT_TYPE_MAP[decl.type] ?? "Unknown";
	const objectNumber = extractObjectNumber(decl);
	const name = extractObjectName(decl);
	const objectId = encodeObjectId(appGuid, objectType, objectNumber);

	const object: ObjectDecl = {
		id: objectId,
		appGuid,
		objectType,
		objectNumber,
		name,
		sourceUnitId,
		sourceHash,
		sourceAnchor: {
			sourceUnitId,
			range: nodeToSourceRange(decl),
			enclosingRoutineId: "",
			syntaxKind: decl.type,
		},
	};

	let table: Table | undefined;
	if (objectType === "Table" || objectType === "TableExtension") {
		table = indexTable(decl, objectId, appGuid, objectNumber, name);
	}

	return { object, objectNode: decl, objectType, table };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/object-indexer.test.ts`
Expected: PASS — 4 tests pass.

> If field/key extraction returns empty, the V2 node type names for `field`/`key`/
> `property_list` differ from the assumptions. Log `node.type` while walking the table
> declaration and cross-check with al-perf's `src/source/indexer.ts` table-handling code.
> Adjust the node-type strings; the structure of the output types does not change.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/index/object-indexer.ts test/object-indexer.test.ts test/fixtures/al/table-item.al
git commit -m "feat: add object indexer (ObjectDecl + Table/Field/Key with ownership)"
```

---

## Task 15: Intraprocedural extraction — loops and operations (`src/index/intraprocedural-ops.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\index\intraprocedural-ops.ts`
- Test: `U:\Git\al-sem\test\intraprocedural-ops.test.ts`
- Test fixture: `U:\Git\al-sem\test\fixtures\al\loop-with-ops.al`

Extracts `LoopNode`s, `OperationSite`s, and `RecordOperation`s from a routine body node, each
tagged with its enclosing `loopStack`. This is half of `IntraproceduralFeatures`; Task 16
does call sites, field accesses, and record variables.

> **Grammar reference:** al-perf's `src/source/indexer.ts` lines 86-98 give loop node types
> (`repeat_statement`, `for_statement`, `foreach_statement`, `while_statement`). Record
> operations are method calls on a record variable — al-perf extracts these; check its
> record-op handling for the call/member node types. Operation site `kind` mapping: a
> `record-op` for record operations, `commit` for `Commit`, `lock` for `LockTable`.

- [ ] **Step 1: Create the fixture**

`test/fixtures/al/loop-with-ops.al`:
```al
codeunit 50300 "Loop With Ops"
{
    procedure Process()
    var
        SalesLine: Record "Sales Line";
        Customer: Record Customer;
    begin
        Customer.SetLoadFields("No.", Name);
        if SalesLine.FindSet() then
            repeat
                Customer.Get(SalesLine."Sell-to Customer No.");
                SalesLine.Modify(true);
            until SalesLine.Next() = 0;
        Commit();
    end;
}
```

- [ ] **Step 2: Write the failing test**

`test/intraprocedural-ops.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseALSource } from "../src/parser/parser-init.ts";
import { collectDescendants } from "../src/parser/ast.ts";
import { extractOpsAndLoops } from "../src/index/intraprocedural-ops.ts";

async function bodyOf(file: string) {
	const source = readFileSync(
		new URL(`./fixtures/al/${file}`, import.meta.url),
		"utf8",
	);
	const tree = await parseALSource(source);
	// The routine body — a code_block node — is the unit extractors walk.
	const blocks = collectDescendants(tree.rootNode, (n) => n.type === "code_block");
	return { block: blocks[0]!, sourceUnitId: `ws:${file}` };
}

describe("extractOpsAndLoops", () => {
	test("collects all loops", async () => {
		const { block, sourceUnitId } = await bodyOf("loop-with-ops.al");
		const result = extractOpsAndLoops(block, "r1", sourceUnitId);
		expect(result.loops).toHaveLength(1);
		expect(result.loops[0]!.type).toBe("repeat");
	});

	test("collects record operations with correct op types", async () => {
		const { block, sourceUnitId } = await bodyOf("loop-with-ops.al");
		const result = extractOpsAndLoops(block, "r1", sourceUnitId);
		const ops = result.recordOperations.map((o) => o.op).sort();
		expect(ops).toContain("FindSet");
		expect(ops).toContain("Get");
		expect(ops).toContain("Modify");
		expect(ops).toContain("SetLoadFields");
		expect(ops).toContain("Next");
	});

	test("tags operations inside the loop with a non-empty loopStack", async () => {
		const { block, sourceUnitId } = await bodyOf("loop-with-ops.al");
		const result = extractOpsAndLoops(block, "r1", sourceUnitId);
		const getOp = result.recordOperations.find((o) => o.op === "Get")!;
		expect(getOp.loopStack.length).toBe(1);
		const setLoad = result.recordOperations.find((o) => o.op === "SetLoadFields")!;
		expect(setLoad.loopStack.length).toBe(0);
	});

	test("captures the record variable name and SetLoadFields field arguments", async () => {
		const { block, sourceUnitId } = await bodyOf("loop-with-ops.al");
		const result = extractOpsAndLoops(block, "r1", sourceUnitId);
		const setLoad = result.recordOperations.find((o) => o.op === "SetLoadFields")!;
		expect(setLoad.recordVariableName).toBe("Customer");
		expect(setLoad.fieldArguments).toEqual(['"No."', "Name"]);
	});

	test("emits a commit operation site", async () => {
		const { block, sourceUnitId } = await bodyOf("loop-with-ops.al");
		const result = extractOpsAndLoops(block, "r1", sourceUnitId);
		expect(result.operationSites.some((s) => s.kind === "commit")).toBe(true);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/intraprocedural-ops.test.ts`
Expected: FAIL — `Cannot find module '../src/index/intraprocedural-ops.ts'`.

- [ ] **Step 4: Write the implementation**

`src/index/intraprocedural-ops.ts`:
```typescript
import type { Node as SyntaxNode } from "web-tree-sitter";
import { nodeToSourceRange } from "../parser/ast.ts";
import type {
	LoopNode,
	LoopType,
	OperationSite,
	RecordOperation,
	RecordOpType,
} from "../model/entities.ts";
import {
	encodeLoopId,
	encodeOperationId,
	type LoopId,
	type RoutineId,
} from "../model/ids.ts";

const LOOP_TYPE_MAP: Record<string, LoopType> = {
	repeat_statement: "repeat",
	for_statement: "for",
	foreach_statement: "foreach",
	while_statement: "while",
};

/** Canonical record-op name (lowercase) -> properly-cased RecordOpType. */
const RECORD_OP_MAP: Record<string, RecordOpType> = {
	findset: "FindSet",
	findfirst: "FindFirst",
	findlast: "FindLast",
	find: "Find",
	get: "Get",
	calcfields: "CalcFields",
	calcsums: "CalcSums",
	modify: "Modify",
	modifyall: "ModifyAll",
	insert: "Insert",
	delete: "Delete",
	deleteall: "DeleteAll",
	setloadfields: "SetLoadFields",
	addloadfields: "AddLoadFields",
	setrange: "SetRange",
	setfilter: "SetFilter",
	setcurrentkey: "SetCurrentKey",
	reset: "Reset",
	copy: "Copy",
	transferfields: "TransferFields",
	validate: "Validate",
	next: "Next",
	count: "Count",
	countapprox: "CountApprox",
	isempty: "IsEmpty",
	locktable: "LockTable",
};

export interface ExtractOpsResult {
	loops: LoopNode[];
	operationSites: OperationSite[];
	recordOperations: RecordOperation[];
}

/** Compute the loop nesting depth of `node` within `root` (max chain of loop ancestors). */
function loopAncestorsOf(
	node: SyntaxNode,
	root: SyntaxNode,
	loopNodeIds: Map<number, LoopId>,
): LoopId[] {
	const stack: LoopId[] = [];
	let current = node.parent;
	while (current && current.id !== root.parent?.id) {
		const loopId = loopNodeIds.get(current.id);
		if (loopId) stack.unshift(loopId);
		if (current.id === root.id) break;
		current = current.parent;
	}
	return stack;
}

/**
 * Parse a method-call expression on a record variable.
 * Returns the receiver name, the method name, and raw argument texts — or null if the
 * node is not a `Receiver.Method(args)` shape.
 *
 * GRAMMAR NOTE: confirm the V2 node type for a member/method call. al-perf's indexer
 * extracts record ops, so its call-handling code names the node types. The shape sought:
 * a call expression whose callee is a member access `<identifier>.<identifier>`.
 */
function parseMethodCall(
	node: SyntaxNode,
): { receiver: string; method: string; args: string[] } | null {
	// A call expression node has a callee child and an argument list child.
	if (!node.type.includes("call")) return null;
	const calleeText = node.childForFieldName("function")?.text ?? node.child(0)?.text ?? "";
	const dot = calleeText.lastIndexOf(".");
	if (dot <= 0) return null;
	const receiver = calleeText.slice(0, dot);
	const method = calleeText.slice(dot + 1);
	const argsNode =
		node.childForFieldName("arguments") ??
		node.namedChildren.find((c) => c?.type.includes("argument"));
	const args: string[] = [];
	if (argsNode) {
		for (const arg of argsNode.namedChildren) {
			if (arg) args.push(arg.text);
		}
	}
	return { receiver, method, args };
}

/**
 * Extract loops, operation sites, and record operations from a routine body node.
 * `bodyNode` is typically the routine's `code_block`.
 */
export function extractOpsAndLoops(
	bodyNode: SyntaxNode,
	routineId: RoutineId,
	sourceUnitId: string,
): ExtractOpsResult {
	// --- pass 1: collect loop nodes and assign LoopIds ---
	const loops: LoopNode[] = [];
	const loopNodeIds = new Map<number, LoopId>();
	{
		const stack: SyntaxNode[] = [bodyNode];
		let loopIndex = 0;
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node) continue;
			const loopType = LOOP_TYPE_MAP[node.type];
			if (loopType) {
				const id = encodeLoopId(routineId, loopIndex++);
				loopNodeIds.set(node.id, id);
				loops.push({
					id,
					type: loopType,
					sourceAnchor: {
						sourceUnitId,
						range: nodeToSourceRange(node),
						enclosingRoutineId: routineId,
						syntaxKind: node.type,
					},
				});
			}
			for (const child of node.namedChildren) if (child) stack.push(child);
		}
	}

	// --- pass 2: collect operation sites and record operations ---
	const operationSites: OperationSite[] = [];
	const recordOperations: RecordOperation[] = [];
	let opIndex = 0;
	{
		const stack: SyntaxNode[] = [bodyNode];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node) continue;

			const call = parseMethodCall(node);
			if (call) {
				const opType = RECORD_OP_MAP[call.method.toLowerCase()];
				const loopStack = loopAncestorsOf(node, bodyNode, loopNodeIds);
				const anchor = {
					sourceUnitId,
					range: nodeToSourceRange(node),
					enclosingRoutineId: routineId,
					syntaxKind: node.type,
				};
				if (opType) {
					const opId = encodeOperationId(routineId, opIndex++);
					const fieldArgsOps = new Set([
						"SetRange",
						"SetFilter",
						"SetLoadFields",
						"AddLoadFields",
						"SetCurrentKey",
					]);
					recordOperations.push({
						id: opId,
						routineId,
						op: opType,
						recordVariableName: call.receiver,
						tempState: { kind: "unknown" },
						fieldArguments: fieldArgsOps.has(opType) ? call.args : undefined,
						loopStack,
						sourceAnchor: anchor,
					});
					operationSites.push({
						id: opId,
						routineId,
						kind: opType === "LockTable" ? "lock" : "record-op",
						sourceAnchor: anchor,
						loopStack,
					});
				}
			}

			// Bare Commit() — a free call, not a record method.
			if (
				node.type.includes("call") &&
				/^commit\b/i.test(node.text.trim())
			) {
				const opId = encodeOperationId(routineId, opIndex++);
				const loopStack = loopAncestorsOf(node, bodyNode, loopNodeIds);
				operationSites.push({
					id: opId,
					routineId,
					kind: "commit",
					sourceAnchor: {
						sourceUnitId,
						range: nodeToSourceRange(node),
						enclosingRoutineId: routineId,
						syntaxKind: node.type,
					},
					loopStack,
				});
			}

			for (const child of node.namedChildren) if (child) stack.push(child);
		}
	}

	return { loops, operationSites, recordOperations };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/intraprocedural-ops.test.ts`
Expected: PASS — 5 tests pass.

> The `parseMethodCall` grammar assumptions (call node type contains `"call"`, callee in
> field `"function"`, args in field `"arguments"`) are the most likely thing to need
> adjustment. If record operations come back empty, log the node types and field names of a
> `Customer.Get(...)` expression and adjust `parseMethodCall`. al-perf's `src/source/
> indexer.ts` already resolves this against the same grammar — use it as the reference.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/index/intraprocedural-ops.ts test/intraprocedural-ops.test.ts test/fixtures/al/loop-with-ops.al
git commit -m "feat: extract loops and record operations from routine bodies"
```

---

## Task 16: Intraprocedural extraction — calls, field accesses, record variables (`src/index/intraprocedural-refs.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\index\intraprocedural-refs.ts`
- Test: `U:\Git\al-sem\test\intraprocedural-refs.test.ts`

Extracts `CallSite`s (non-record-op calls — plain procedure invocations), `FieldAccess`es
(`RecordVar.FieldName` reads), and `RecordVariable` declarations from a routine. Together with
Task 15 this completes `IntraproceduralFeatures`.

- [ ] **Step 1: Write the failing test**

`test/intraprocedural-refs.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { parseALSource } from "../src/parser/parser-init.ts";
import { collectDescendants } from "../src/parser/ast.ts";
import { extractRefs } from "../src/index/intraprocedural-refs.ts";

const SRC = `
codeunit 50400 "Refs"
{
    procedure Process(var SalesLine: Record "Sales Line"; Qty: Integer)
    var
        Customer: Record Customer;
        TempBuffer: Record "Integer" temporary;
        i: Integer;
    begin
        EnrichLine(SalesLine);
        Customer.Get(SalesLine."Sell-to Customer No.");
        i := SalesLine.Quantity + Customer."Credit Limit (LCY)";
    end;
}`;

async function refsOf() {
	const tree = await parseALSource(SRC);
	const procNode = collectDescendants(tree.rootNode, (n) => n.type === "procedure")[0]!;
	return extractRefs(procNode, "r1", "ws:refs.al");
}

describe("extractRefs", () => {
	test("collects non-record-op call sites", async () => {
		const result = await refsOf();
		const callees = result.callSites.map((c) => c.calleeText);
		expect(callees).toContain("EnrichLine");
		// Customer.Get is a record op, not a plain call site — excluded here.
		expect(callees.some((c) => c.includes("Get"))).toBe(false);
	});

	test("collects field accesses as RecordVar.Field pairs", async () => {
		const result = await refsOf();
		const pairs = result.fieldAccesses.map(
			(f) => `${f.recordVariableName}.${f.fieldName}`,
		);
		expect(pairs).toContain("SalesLine.Quantity");
		expect(pairs).toContain('Customer."Credit Limit (LCY)"');
	});

	test("collects record variables with temp state and parameter flags", async () => {
		const result = await refsOf();
		const byName = new Map(result.recordVariables.map((v) => [v.name, v]));
		expect(byName.get("Customer")?.tableName).toBe("Customer");
		expect(byName.get("Customer")?.tempState).toEqual({ kind: "known", value: false });
		expect(byName.get("TempBuffer")?.tempState).toEqual({
			kind: "known",
			value: true,
		});
		expect(byName.get("SalesLine")?.isParameter).toBe(true);
		expect(byName.get("SalesLine")?.parameterIndex).toBe(0);
		// SalesLine is a by-var record parameter — temp-ness is caller-dependent.
		expect(byName.get("SalesLine")?.tempState).toEqual({
			kind: "parameter-dependent",
			parameterIndex: 0,
		});
	});

	test("non-record local variables are excluded from recordVariables", async () => {
		const result = await refsOf();
		expect(result.recordVariables.some((v) => v.name === "i")).toBe(false);
		expect(result.recordVariables.some((v) => v.name === "Qty")).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/intraprocedural-refs.test.ts`
Expected: FAIL — `Cannot find module '../src/index/intraprocedural-refs.ts'`.

- [ ] **Step 3: Write the implementation**

`src/index/intraprocedural-refs.ts`:
```typescript
import type { Node as SyntaxNode } from "web-tree-sitter";
import { collectDescendants, nodeToSourceRange, stripQuotes } from "../parser/ast.ts";
import type {
	CallSite,
	FieldAccess,
	ParameterSymbol,
	RecordVariable,
	TempState,
} from "../model/entities.ts";
import {
	encodeCallsiteId,
	encodeOperationId,
	encodeRecordVariableId,
	type RoutineId,
} from "../model/ids.ts";

export interface ExtractRefsResult {
	callSites: CallSite[];
	fieldAccesses: FieldAccess[];
	recordVariables: RecordVariable[];
}

const RECORD_OP_NAMES = new Set([
	"findset", "findfirst", "findlast", "find", "get", "calcfields", "calcsums",
	"modify", "modifyall", "insert", "delete", "deleteall", "setloadfields",
	"addloadfields", "setrange", "setfilter", "setcurrentkey", "reset", "copy",
	"transferfields", "validate", "next", "count", "countapprox", "isempty", "locktable",
]);

/**
 * Parse `var` blocks and the parameter list of a routine into RecordVariable records.
 * Only Record-typed variables are returned. A by-var Record parameter has
 * parameter-dependent temp state; a local `temporary` Record is known-temp.
 *
 * GRAMMAR NOTE: variable declarations live in `var_section` / `variable_declaration`
 * nodes; parameters in a `parameter_list` with `parameter` children. Confirm exact node
 * names against al-perf's `src/source/indexer.ts` variable extraction.
 */
function extractRecordVariables(
	procNode: SyntaxNode,
	routineId: RoutineId,
): { recordVariables: RecordVariable[]; parameters: ParameterSymbol[] } {
	const recordVariables: RecordVariable[] = [];
	const parameters: ParameterSymbol[] = [];

	// --- parameters ---
	const paramList = procNode.namedChildren.find(
		(c) => c?.type.includes("parameter_list") || c?.type.includes("parameters"),
	);
	if (paramList) {
		let pIndex = 0;
		for (const param of paramList.namedChildren) {
			if (!param || !param.type.includes("parameter")) continue;
			const text = param.text;
			const isVar = /^\s*var\b/i.test(text);
			// "<name>: <type>"
			const colon = text.indexOf(":");
			const namePart = (colon >= 0 ? text.slice(0, colon) : text)
				.replace(/^\s*var\b/i, "")
				.trim();
			const typePart = colon >= 0 ? text.slice(colon + 1).trim() : "";
			const recordMatch = typePart.match(/^Record\s+("?[^";]+"?)/i);
			const isRecord = !!recordMatch;
			const tableName = recordMatch ? stripQuotes(recordMatch[1]!.trim()) : undefined;
			const index = pIndex++;
			parameters.push({
				index,
				name: namePart,
				typeText: typePart,
				isVar,
				isRecord,
				tableName,
			});
			if (isRecord) {
				const tempState: TempState = isVar
					? { kind: "parameter-dependent", parameterIndex: index }
					: { kind: "known", value: false };
				recordVariables.push({
					id: encodeRecordVariableId(routineId, namePart),
					name: namePart,
					tableName,
					tempState,
					isParameter: true,
					parameterIndex: index,
				});
			}
		}
	}

	// --- local variable declarations ---
	const varDecls = collectDescendants(
		procNode,
		(n) => n.type.includes("variable_declaration"),
	);
	for (const decl of varDecls) {
		const text = decl.text;
		// "<name>: Record <Table> [temporary];"
		const colon = text.indexOf(":");
		if (colon < 0) continue;
		const name = text.slice(0, colon).trim();
		const typePart = text.slice(colon + 1).trim();
		const recordMatch = typePart.match(/^Record\s+("?[^";]+?"?)\s*(temporary)?\s*;?$/i);
		if (!recordMatch) continue;
		const tableName = stripQuotes(recordMatch[1]!.trim());
		const isTemporary = !!recordMatch[2];
		recordVariables.push({
			id: encodeRecordVariableId(routineId, name),
			name,
			tableName,
			tempState: { kind: "known", value: isTemporary },
			isParameter: false,
		});
	}

	return { recordVariables, parameters };
}

/**
 * Extract call sites (plain procedure calls, excluding record operations), field accesses,
 * and record variables from a routine node.
 */
export function extractRefs(
	procNode: SyntaxNode,
	routineId: RoutineId,
	sourceUnitId: string,
): ExtractRefsResult & { parameters: ParameterSymbol[] } {
	const { recordVariables, parameters } = extractRecordVariables(procNode, routineId);
	const recordVarNames = new Set(
		recordVariables.map((v) => v.name.toLowerCase()),
	);

	const callSites: CallSite[] = [];
	const fieldAccesses: FieldAccess[] = [];
	let csIndex = 0;

	// --- call sites: call expressions whose method is NOT a record op ---
	const callNodes = collectDescendants(procNode, (n) => n.type.includes("call"));
	for (const node of callNodes) {
		const calleeText =
			node.childForFieldName("function")?.text ?? node.child(0)?.text ?? "";
		if (!calleeText) continue;
		const dot = calleeText.lastIndexOf(".");
		const method = dot >= 0 ? calleeText.slice(dot + 1) : calleeText;
		// Skip record operations — they are handled by intraprocedural-ops.
		if (RECORD_OP_NAMES.has(method.toLowerCase())) continue;
		// Skip bare Commit() — handled as an operation site in intraprocedural-ops.
		if (/^commit$/i.test(method)) continue;
		const argsNode =
			node.childForFieldName("arguments") ??
			node.namedChildren.find((c) => c?.type.includes("argument"));
		const argumentTexts: string[] = [];
		if (argsNode) {
			for (const arg of argsNode.namedChildren) if (arg) argumentTexts.push(arg.text);
		}
		const id = encodeCallsiteId(routineId, csIndex);
		callSites.push({
			id,
			operationId: encodeOperationId(routineId, csIndex),
			calleeText,
			argumentTexts,
			loopStack: [], // populated by the routine indexer which knows the loop map
			sourceAnchor: {
				sourceUnitId,
				range: nodeToSourceRange(node),
				enclosingRoutineId: routineId,
				syntaxKind: node.type,
			},
		});
		csIndex++;
	}

	// --- field accesses: member_access nodes <RecordVar>.<Field> where RecordVar is a record var ---
	const memberNodes = collectDescendants(
		procNode,
		(n) => n.type.includes("member") || n.type.includes("field_access"),
	);
	for (const node of memberNodes) {
		const text = node.text;
		const dot = text.indexOf(".");
		if (dot <= 0) continue;
		const recordVariableName = text.slice(0, dot).trim();
		const fieldName = text.slice(dot + 1).trim();
		if (!recordVarNames.has(recordVariableName.toLowerCase())) continue;
		// Exclude method calls — a field access has no parens.
		if (fieldName.includes("(")) continue;
		fieldAccesses.push({
			recordVariableName,
			fieldName,
			sourceAnchor: {
				sourceUnitId,
				range: nodeToSourceRange(node),
				enclosingRoutineId: routineId,
				syntaxKind: node.type,
			},
		});
	}

	return { callSites, fieldAccesses, recordVariables, parameters };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/intraprocedural-refs.test.ts`
Expected: PASS — 4 tests pass.

> The member-access node type (`member_access`, `field_access`, or similar) and the
> variable-declaration node type are the likely adjustment points. If field accesses or
> record variables come back empty, log node types from the test source and cross-check
> with al-perf's `src/source/indexer.ts` (it extracts both `fieldAccesses` and `variables`).

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/index/intraprocedural-refs.ts test/intraprocedural-refs.test.ts
git commit -m "feat: extract call sites, field accesses, and record variables"
```

---

## Task 17: Routine indexer (`src/index/routine-indexer.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\index\routine-indexer.ts`
- Test: `U:\Git\al-sem\test\routine-indexer.test.ts`

Walks an object declaration node, finds every procedure and trigger, builds the
`CanonicalRoutineKey` + `RoutineId`, classifies the `RoutineKind` (procedure / trigger /
event-publisher / event-subscriber via attributes), and assembles `IntraproceduralFeatures`
by calling the Task 15 and Task 16 extractors. It also back-fills `loopStack` on call sites
(Task 16 left it empty because it did not have the loop map).

> **Grammar/attribute reference:** al-perf's `src/source/indexer.ts` lines 110-164 show how
> event attributes are detected — `[EventSubscriber(...)]`, `[IntegrationEvent]`,
> `[BusinessEvent]` are read from the source lines preceding the procedure. Procedure name is
> `proc.childForFieldName("name")`; trigger name likewise. The body is the `code_block` child.

- [ ] **Step 1: Write the failing test**

`test/routine-indexer.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { parseALSource } from "../src/parser/parser-init.ts";
import { indexObject } from "../src/index/object-indexer.ts";
import { indexRoutines } from "../src/index/routine-indexer.ts";

const SRC = `
codeunit 50500 "Routines"
{
    procedure PublicWork()
    var
        Cust: Record Customer;
    begin
        Cust.FindSet();
        Helper();
    end;

    local procedure Helper()
    begin
    end;

    [IntegrationEvent(false, false)]
    procedure OnAfterDoStuff()
    begin
    end;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", 'OnBeforePost', '', true, true)]
    local procedure HandleBeforePost()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.ModifyAll(Quantity, 0);
    end;
}`;

async function index() {
	const tree = await parseALSource(SRC);
	const obj = indexObject({
		tree,
		appGuid: "guid",
		sourceUnitId: "ws:routines.al",
		modelInstanceId: "mi1",
		sourceHash: "h",
	});
	return indexRoutines({
		objectNode: obj.objectNode!,
		object: obj.object!,
		sourceUnitId: "ws:routines.al",
		modelInstanceId: "mi1",
		sourceLines: SRC.split("\n"),
	});
}

describe("indexRoutines", () => {
	test("indexes every procedure and classifies kinds", async () => {
		const routines = await index();
		const byName = new Map(routines.map((r) => [r.name, r]));
		expect(byName.get("PublicWork")?.kind).toBe("procedure");
		expect(byName.get("OnAfterDoStuff")?.kind).toBe("event-publisher");
		expect(byName.get("HandleBeforePost")?.kind).toBe("event-subscriber");
	});

	test("attaches intraprocedural features", async () => {
		const routines = await index();
		const publicWork = routines.find((r) => r.name === "PublicWork")!;
		expect(publicWork.features.recordOperations.some((o) => o.op === "FindSet")).toBe(
			true,
		);
		expect(publicWork.features.callSites.some((c) => c.calleeText === "Helper")).toBe(
			true,
		);
	});

	test("builds a canonical key and a routine id scoped to the model instance", async () => {
		const routines = await index();
		const publicWork = routines.find((r) => r.name === "PublicWork")!;
		expect(publicWork.canonical.routineName).toBe("PublicWork");
		expect(publicWork.canonical.objectNumber).toBe(50500);
		expect(publicWork.id).toContain("mi1");
	});

	test("marks bodyAvailable true for source-indexed routines", async () => {
		const routines = await index();
		expect(routines.every((r) => r.bodyAvailable)).toBe(true);
	});

	test("captures by-value parameters with correct record temp state", async () => {
		const routines = await index();
		const handler = routines.find((r) => r.name === "HandleBeforePost")!;
		const salesLine = handler.features.recordVariables.find(
			(v) => v.name === "SalesLine",
		)!;
		expect(salesLine.tempState).toEqual({ kind: "known", value: false });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/routine-indexer.test.ts`
Expected: FAIL — `Cannot find module '../src/index/routine-indexer.ts'`.

- [ ] **Step 3: Write the implementation**

`src/index/routine-indexer.ts`:
```typescript
import type { Node as SyntaxNode } from "web-tree-sitter";
import { collectDescendants, nodeToSourceRange, stripQuotes } from "../parser/ast.ts";
import { sha256Hex } from "../hash.ts";
import type { IntraproceduralFeatures, ObjectDecl, Routine } from "../model/entities.ts";
import {
	type CanonicalRoutineKey,
	encodeRoutineId,
	type RoutineKind,
} from "../model/ids.ts";
import { extractOpsAndLoops } from "./intraprocedural-ops.ts";
import { extractRefs } from "./intraprocedural-refs.ts";

export interface IndexRoutinesInput {
	objectNode: SyntaxNode;
	object: ObjectDecl;
	sourceUnitId: string;
	modelInstanceId: string;
	sourceLines: string[];
}

/** Classify a routine's kind from the attribute lines preceding it. */
function classifyKind(
	sourceLines: string[],
	nodeStartRow: number,
	isTrigger: boolean,
): RoutineKind {
	const start = Math.max(0, nodeStartRow - 6);
	for (let i = start; i < nodeStartRow; i++) {
		const line = sourceLines[i] ?? "";
		if (/\[EventSubscriber\b/i.test(line)) return "event-subscriber";
		if (/\[IntegrationEvent\b/i.test(line) || /\[BusinessEvent\b/i.test(line)) {
			return "event-publisher";
		}
	}
	return isTrigger ? "trigger" : "procedure";
}

function findCodeBlock(node: SyntaxNode): SyntaxNode | null {
	for (const child of node.namedChildren) {
		if (child?.type === "code_block") return child;
	}
	return null;
}

/** Index every procedure and trigger in an object declaration node. */
export function indexRoutines(input: IndexRoutinesInput): Routine[] {
	const { objectNode, object, sourceUnitId, modelInstanceId, sourceLines } = input;
	const routines: Routine[] = [];

	const routineNodes = collectDescendants(
		objectNode,
		(n) => n.type === "procedure" || n.type === "trigger_declaration",
	);

	for (const node of routineNodes) {
		const isTrigger = node.type === "trigger_declaration";
		const nameNode = node.childForFieldName("name");
		const name = nameNode ? stripQuotes(nameNode.text) : "";
		if (!name) continue;

		const kind = classifyKind(sourceLines, node.startPosition.row, isTrigger);

		const canonical: CanonicalRoutineKey = {
			appGuid: object.appGuid,
			objectType: object.objectType,
			objectNumber: object.objectNumber,
			routineKind: kind,
			routineName: name,
			normalizedSignatureHash: sha256Hex(
				(node.childForFieldName("parameters")?.text ?? "").replace(/\s+/g, ""),
			),
		};
		const routineId = encodeRoutineId(canonical, modelInstanceId);

		const body = findCodeBlock(node);
		const opsResult = body
			? extractOpsAndLoops(body, routineId, sourceUnitId)
			: { loops: [], operationSites: [], recordOperations: [] };
		const refsResult = extractRefs(node, routineId, sourceUnitId);

		// Back-fill loopStack on call sites: a call site's loop stack is the loop stack of
		// any operation site sharing its source range start, else empty. Simpler and
		// correct here: recompute from the loops list by range containment.
		for (const callSite of refsResult.callSites) {
			callSite.loopStack = opsResult.loops
				.filter((loop) => {
					const lr = loop.sourceAnchor.range;
					const cr = callSite.sourceAnchor.range;
					return (
						(lr.startLine < cr.startLine ||
							(lr.startLine === cr.startLine &&
								lr.startColumn <= cr.startColumn)) &&
						(lr.endLine > cr.endLine ||
							(lr.endLine === cr.endLine && lr.endColumn >= cr.endColumn))
					);
				})
				.map((loop) => loop.id);
		}

		const features: IntraproceduralFeatures = {
			loops: opsResult.loops,
			operationSites: opsResult.operationSites,
			recordOperations: opsResult.recordOperations,
			callSites: refsResult.callSites,
			fieldAccesses: refsResult.fieldAccesses,
			recordVariables: refsResult.recordVariables,
			nestingDepth: opsResult.loops.length, // refined in Phase 2; loop count is fine here
		};

		routines.push({
			id: routineId,
			canonical,
			objectId: object.id,
			name,
			kind,
			parameters: refsResult.parameters,
			bodyAvailable: body !== null,
			parseIncomplete: node.hasError ?? false,
			sourceHash: sha256Hex(node.text),
			sourceAnchor: {
				sourceUnitId,
				range: nodeToSourceRange(node),
				enclosingRoutineId: routineId,
				syntaxKind: node.type,
			},
			features,
		});
	}

	return routines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/routine-indexer.test.ts`
Expected: PASS — 5 tests pass.

> If `node.hasError` is not a property on the tree-sitter node in this `web-tree-sitter`
> version, use `node.hasError` as a method call `node.hasError()` or check
> `tree.rootNode.hasError`. Adjust to whatever the installed `web-tree-sitter` exposes.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/index/routine-indexer.ts test/routine-indexer.test.ts
git commit -m "feat: add routine indexer (kinds, canonical keys, intraprocedural features)"
```

---

## Task 18: Index orchestrator (`src/index/indexer.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\index\indexer.ts`
- Test: `U:\Git\al-sem\test\indexer.test.ts`

Takes the discovered `SourceUnit[]` + `ModelIdentity`, parses every `source` unit, runs the
object and routine indexers, and assembles the `SemanticIndex`. Parse failures degrade
gracefully — a bad file is skipped with a diagnostic, never crashes the run.

- [ ] **Step 1: Write the failing test**

`test/indexer.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { buildSemanticIndex } from "../src/index/indexer.ts";
import type { SourceUnit } from "../src/providers/types.ts";
import type { ModelIdentity } from "../src/model/identity.ts";

const IDENTITY: ModelIdentity = {
	schemaVersion: "1",
	analyzerVersion: "0.0.1",
	grammarVersion: "v2",
	symbolReaderVersion: "1",
	createdAt: "1970-01-01T00:00:00.000Z",
	apps: [{ appGuid: "guid", publisher: "p", name: "n", version: "1.0.0.0", sourceKind: "workspace" }],
	dependencyGraphHash: "h",
};

function unit(relativePath: string, content: string): SourceUnit {
	return {
		id: `ws:${relativePath}`,
		kind: "source",
		appGuid: "guid",
		relativePath,
		content,
		sourceProvider: "workspace",
	};
}

describe("buildSemanticIndex", () => {
	test("indexes objects and routines across multiple units", async () => {
		const units = [
			unit("a.al", 'codeunit 50100 "A" { procedure Run() begin end; }'),
			unit("b.al", 'table 50200 "B" { fields { field(1; "No."; Code[20]) { } } }'),
		];
		const result = await buildSemanticIndex(units, IDENTITY, "mi1");
		expect(result.index.objects.map((o) => o.name).sort()).toEqual(["A", "B"]);
		expect(result.index.routines.some((r) => r.name === "Run")).toBe(true);
		expect(result.index.tables.some((t) => t.name === "B")).toBe(true);
	});

	test("symbol-only units are skipped without error", async () => {
		const units: SourceUnit[] = [
			{
				id: "app:dep:__symbols__",
				kind: "symbol-only",
				appGuid: "dep",
				relativePath: "__symbols__",
				sourceProvider: "app-package",
			},
		];
		const result = await buildSemanticIndex(units, IDENTITY, "mi1");
		expect(result.index.objects).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});

	test("a malformed file is skipped with a diagnostic, run does not crash", async () => {
		const units = [
			unit("good.al", 'codeunit 50100 "Good" { procedure Run() begin end; }'),
			unit("bad.al", "this is not valid AL @@@ {{{"),
		];
		const result = await buildSemanticIndex(units, IDENTITY, "mi1");
		// The good file is still indexed.
		expect(result.index.objects.some((o) => o.name === "Good")).toBe(true);
		// The bad file produced a diagnostic.
		expect(
			result.diagnostics.some(
				(d) => d.stage === "index" && d.sourceRef === "ws:bad.al",
			),
		).toBe(true);
	});

	test("the index carries the supplied ModelIdentity", async () => {
		const result = await buildSemanticIndex([], IDENTITY, "mi1");
		expect(result.index.identity).toBe(IDENTITY);
		expect(result.index.apps).toEqual([
			{ appGuid: "guid", publisher: "p", name: "n", version: "1.0.0.0" },
		]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/indexer.test.ts`
Expected: FAIL — `Cannot find module '../src/index/indexer.ts'`.

- [ ] **Step 3: Write the implementation**

`src/index/indexer.ts`:
```typescript
import { sha256Hex } from "../hash.ts";
import type { App } from "../model/entities.ts";
import type { ModelIdentity } from "../model/identity.ts";
import type { Diagnostic } from "../model/finding.ts";
import type { SemanticIndex } from "../model/model.ts";
import { parseALSource } from "../parser/parser-init.ts";
import type { SourceUnit } from "../providers/types.ts";
import { indexObject } from "./object-indexer.ts";
import { indexRoutines } from "./routine-indexer.ts";

export interface BuildIndexResult {
	index: SemanticIndex;
	diagnostics: Diagnostic[];
}

/**
 * Parse and index every source unit into a SemanticIndex. Parse/index failures degrade
 * gracefully: the offending unit is skipped with a diagnostic; other units still index.
 */
export async function buildSemanticIndex(
	units: SourceUnit[],
	identity: ModelIdentity,
	modelInstanceId: string,
): Promise<BuildIndexResult> {
	const diagnostics: Diagnostic[] = [];
	const index: SemanticIndex = {
		identity,
		apps: identity.apps.map(
			(a): App => ({
				appGuid: a.appGuid,
				publisher: a.publisher,
				name: a.name,
				version: a.version,
			}),
		),
		objects: [],
		routines: [],
		tables: [],
	};

	for (const unit of units) {
		if (unit.kind !== "source" || unit.content === undefined) continue;
		try {
			const tree = await parseALSource(unit.content);
			const sourceHash = sha256Hex(unit.content);
			const objResult = indexObject({
				tree,
				appGuid: unit.appGuid,
				sourceUnitId: unit.id,
				modelInstanceId,
				sourceHash,
			});
			if (!objResult.object || !objResult.objectNode) {
				diagnostics.push({
					severity: "info",
					stage: "index",
					message: `No object declaration found in ${unit.relativePath}`,
					sourceRef: unit.id,
				});
				continue;
			}
			index.objects.push(objResult.object);
			if (objResult.table) index.tables.push(objResult.table);

			const routines = indexRoutines({
				objectNode: objResult.objectNode,
				object: objResult.object,
				sourceUnitId: unit.id,
				modelInstanceId,
				sourceLines: unit.content.split("\n"),
			});
			index.routines.push(...routines);
		} catch (err) {
			diagnostics.push({
				severity: "warning",
				stage: "index",
				message: `Failed to index ${unit.relativePath}: ${(err as Error).message}`,
				sourceRef: unit.id,
			});
		}
	}

	return { index, diagnostics };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/indexer.test.ts`
Expected: PASS — 4 tests pass.

> The "malformed file" test assumes a clearly-invalid file either throws during parse/index
> or yields no object declaration. tree-sitter is error-tolerant and may still return a tree
> with error nodes — in that case `indexObject` returns `{}` (no object declaration found)
> and the `info` diagnostic fires instead of a `warning`. If the test fails on the
> diagnostic assertion, broaden it to accept either: `d.sourceRef === "ws:bad.al"` with
> stage `"index"`.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/al-sem
git add src/index/indexer.ts test/indexer.test.ts
git commit -m "feat: add semantic index orchestrator with graceful degradation"
```

---

## Task 19: `analyzeWorkspace` entry point + end-to-end test (`src/index.ts`)

**Files:**
- Create: `U:\Git\al-sem\src\index.ts`
- Test: `U:\Git\al-sem\test\analyze-workspace.test.ts`

The Phase 1 public entry point. Wires discovery → indexing, returns `{ index, diagnostics }`.
Also re-exports the model types so `al-perf` (and Phases 2–3) import from one place.

- [ ] **Step 1: Write the failing end-to-end test**

`test/analyze-workspace.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { analyzeWorkspace } from "../src/index.ts";

const WS_ROOT = new URL("./fixtures/ws", import.meta.url).pathname;
const ALPACKAGES = new URL("./fixtures/alpackages", import.meta.url).pathname;

describe("analyzeWorkspace (Phase 1 end-to-end)", () => {
	test("returns a populated SemanticIndex for a workspace", async () => {
		const result = await analyzeWorkspace({ workspaceRoot: WS_ROOT });
		expect(result.index.objects.map((o) => o.name).sort()).toEqual([
			"CU A",
			"CU B",
		]);
		expect(result.index.routines.length).toBeGreaterThanOrEqual(2);
		expect(result.index.identity.primaryApp?.name).toBe("Test Workspace App");
	});

	test("includes app-package source when alpackages is supplied", async () => {
		const result = await analyzeWorkspace({
			workspaceRoot: WS_ROOT,
			alpackagesDir: ALPACKAGES,
		});
		expect(result.index.objects.some((o) => o.name === "Sample Dep")).toBe(true);
		expect(
			result.index.identity.apps.some(
				(a) => a.appGuid === "22222222-2222-2222-2222-222222222222",
			),
		).toBe(true);
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
		expect(JSON.stringify(a.index)).toBe(JSON.stringify(b.index));
	});

	test("never throws on a missing workspace — returns empty index + diagnostic", async () => {
		const result = await analyzeWorkspace({ workspaceRoot: "/no/such/dir" });
		expect(result.index.objects).toEqual([]);
		expect(result.diagnostics.length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd U:/Git/al-sem && bun test test/analyze-workspace.test.ts`
Expected: FAIL — `Cannot find module '../src/index.ts'` (or `analyzeWorkspace` not exported).

- [ ] **Step 3: Write the implementation**

`src/index.ts`:
```typescript
export * from "./model/index.ts";
export type { SourceUnit, SourceProvider } from "./providers/types.ts";
export { ExternalSourceProvider } from "./providers/external.ts";

import type { Diagnostic } from "./model/finding.ts";
import type { SemanticIndex } from "./model/model.ts";
import { ExternalSourceProvider } from "./providers/external.ts";
import { discoverSources } from "./providers/discover.ts";
import { buildSemanticIndex } from "./index/indexer.ts";

export interface AnalyzeWorkspaceOptions {
	workspaceRoot: string;
	alpackagesDir?: string;
	externalProvider?: ExternalSourceProvider;
	/** When true, createdAt is pinned to the epoch so output is byte-deterministic. */
	deterministic?: boolean;
}

export interface AnalyzeWorkspaceResult {
	index: SemanticIndex;
	diagnostics: Diagnostic[];
}

/**
 * Phase 1 entry point. Discovers sources, parses and indexes them, and returns a
 * SemanticIndex. Phase 2 will extend this to a full SemanticModel (call graph, event
 * graph, routine summaries). Never throws — failures surface as diagnostics.
 */
export async function analyzeWorkspace(
	options: AnalyzeWorkspaceOptions,
): Promise<AnalyzeWorkspaceResult> {
	const discovery = await discoverSources({
		workspaceRoot: options.workspaceRoot,
		alpackagesDir: options.alpackagesDir,
		externalProvider: options.externalProvider,
	});

	const identity = options.deterministic
		? discovery.identity
		: { ...discovery.identity, createdAt: new Date().toISOString() };

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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd U:/Git/al-sem && bun test test/analyze-workspace.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `cd U:/Git/al-sem && bun test && bunx tsc --noEmit && bunx biome check src test`
Expected: all tests pass; `tsc` exits 0; biome reports no errors (fix any formatting with
`bunx biome format --write src test` and re-commit if needed).

- [ ] **Step 6: Commit**

```bash
cd U:/Git/al-sem
git add src/index.ts test/analyze-workspace.test.ts
git commit -m "feat: add analyzeWorkspace Phase 1 entry point"
```

---

## Self-Review Notes (for the implementer)

Before declaring Phase 1 done, verify against the spec:

1. **Spec coverage:**
   - Section 1 architecture L0–L2 → Tasks 6–18 ✓
   - Section 2 data model → Tasks 3–5 define every type ✓ (`callGraph`, `eventGraph`,
     `summary`, `AnalysisCoverage` are typed but not populated — correct for Phase 1)
   - Section 2 two-level identity → Task 3 ✓; `ModelIdentity` → Tasks 4, 13 ✓
   - Section 2 table-extension ownership → Task 14 (`declaringObjectId`/`declaringAppId`) ✓
   - Section 5 resolver scope → Phase 2 (not this plan)
   - Section 6 graceful degradation → Tasks 10, 11, 18 ✓
   - Section 7 TDD + fixtures + determinism → every task is test-first; Task 19 determinism test ✓
   - Section 8 project structure → Task 1 ✓

2. **Known grammar-assumption risks:** Tasks 7, 14, 15, 16, 17 contain explicit notes where
   V2 grammar node type names are assumed. If a test fails on empty extraction, the fix is
   always: log `node.type`, cross-check `U:\Git\al-perf\src\source\indexer.ts`, adjust the
   node-type string. The output type shapes never change.

3. **Phase boundary:** `analyzeWorkspace` returns `SemanticIndex`, not `SemanticModel`. That
   is intentional — Phase 2 adds the graph layers.

---

## Execution Handoff

Phase 1 plan complete. When ready to build, the two execution options are:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks
2. **Inline Execution** — execute tasks in this session with checkpoints

Phase 2 (Graph + Engine) and Phase 3 (Detectors + Surfaces) plans will be written after
Phase 1 is implemented and reviewed.
