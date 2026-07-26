# Extension Table Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the source index a resolved per-table picture that merges every `tableextension`'s fields and keys into the table they extend, so detectors stop reasoning about a BC table from one fragment of it.

**Architecture:** A new `SourceIndex.tables: Map<lowercased name, ResolvedTable>` is built once by a pure function `buildTableIndex(objects)` and rebuilt identically on cache deserialization. `index.objects` is untouched and stays the literal record of what was parsed. Four consumers (`table-graph`, `resolveCalcFields`, `detectIncompleteSetLoadFields`, `detectUnindexedFilters`) replace their per-operation linear scans with a map lookup, each fenced by `rootSeen` / `ambiguous` according to whether their question is answerable from a fragment.

**Tech Stack:** Bun, TypeScript, `bun:test`, `web-tree-sitter` + `tree-sitter-al.wasm` (pinned by `AL_GRAMMAR_VERSION` in `src/source/parser-init.ts`), biome for lint/format.

**Spec:** `docs/superpowers/specs/2026-07-26-extension-table-merge-design.md`

## Global Constraints

- Run `bun run verify` (biome + `tsc --noEmit` + full suite) before every commit. It must be green.
- Never modify `involvedMethods` on any finding. It is the lifecycle fingerprint anchor via `resolvePatternAnchor` (`src/lifecycle/wire.ts`). No task here touches it.
- `rootSeen` means "the root `table` declaration was indexed". It NEVER means every extension was seen. No comment, description or test may claim otherwise.
- An `ambiguous` entry answers nothing: every consumer treats it exactly as it treats an absent table.
- Keys are NEVER deduplicated across contributors. A `tableextension` may legally reuse a base key's name (Microsoft Learn, *Table keys*: "You can use the same key name in the table extension, unless the key contains fields from the base table object").
- `primaryKey` comes only from the root. An extension key is always a secondary key by BC definition.
- Prefer the Edit tool over shell heredocs for anything containing backslash escapes — `python3` heredocs have mangled `\b`/`\f` into literal control bytes in this repo twice.
- Commit trailer on every commit: `Claude-Session: https://claude.ai/code/session_01YLmrajt7dZLmFW24pSQ2Ue`

---

### Task 1: Capture `extendsTarget` on every extension object

**Files:**
- Modify: `src/types/source-index.ts:68-82` (`ObjectInfo`)
- Modify: `src/source/indexer.ts:1668-1679` (the `indexALFile` return object)
- Modify: `src/source/indexer.ts` (add `extractExtendsTarget` near `extractObjectName` at line 286-300)
- Test: `test/source/indexer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ObjectInfo.extendsTarget?: string` — the base object's name with quotes stripped, present only on `*Extension` objects that declare `extends`. Task 2's `buildTableIndex` reads it.

Background: an extension declaration parses as
`tableextension_declaration → [tableextension_keyword, integer, identifier, extends_keyword, quoted_identifier|identifier]`.
The target is the first `identifier`/`quoted_identifier` that appears **after** the `extends_keyword` child. `extractObjectName` (line 290) already returns the first one *before* it, which is the extension's own name — do not reuse it.

- [ ] **Step 1: Write the failing test**

Add to `test/source/indexer.test.ts`, inside the existing `describe("record parameters", ...)` block's file (top level is fine — put it immediately after that describe block closes):

```ts
describe("extension objects", () => {
	it("records the base object an extension extends", async () => {
		// `tableextension 50905 "Implicit Rec Table Ext" extends Customer`.
		// extractObjectName returns the first identifier in the declaration,
		// which is the EXTENSION's name — the target sits after extends_keyword.
		const result = (await indexALFile(
			resolve(fixturesDir, "ImplicitRecTableExt.al"),
			fixturesDir,
		))!;
		expect(result.objectType).toBe("TableExtension");
		expect(result.objectName).toBe("Implicit Rec Table Ext");
		expect(result.extendsTarget).toBe("Customer");
	});

	it("leaves extendsTarget undefined on a non-extension object", async () => {
		const result = (await indexALFile(
			resolve(fixturesDir, "Table50400.al"),
			fixturesDir,
		))!;
		expect(result.extendsTarget).toBeUndefined();
	});
});
```

First confirm the fixture filename holding `tableextension 50905`:

```bash
grep -rl 'tableextension 50905' test/fixtures/source/
```

If the file is not named `ImplicitRecTableExt.al`, use the name that command prints.

- [ ] **Step 2: Run test to verify it fails**

Run: `AI_DISABLED=1 bun test test/source/indexer.test.ts -t "records the base object"`
Expected: FAIL — `expect(received).toBe(expected)`, received `undefined`.

- [ ] **Step 3: Add the type field**

In `src/types/source-index.ts`, inside `interface ObjectInfo`, after `sourceTableTemporary`:

```ts
	/**
	 * The object this one extends, for `tableextension` / `pageextension` /
	 * `reportextension` / `enumextension`. Quotes stripped. Undefined on a
	 * root declaration and on an extension whose `extends` clause failed to
	 * parse. Only TableExtension currently feeds a consumer (`buildTableIndex`);
	 * the others are captured because it is one code path and the fact is the
	 * enabling data for any future one.
	 */
	extendsTarget?: string;
```

- [ ] **Step 4: Write the extractor**

In `src/source/indexer.ts`, immediately after `extractObjectName` (which ends at line 300):

```ts
/**
 * The object an `…extension` declaration extends. The target is the first
 * identifier AFTER `extends_keyword` — `extractObjectName` returns the first
 * one before it, which is the extension's own name.
 */
function extractExtendsTarget(decl: SyntaxNode): string | undefined {
	let seenExtends = false;
	for (const child of decl.namedChildren) {
		if (child.type === "extends_keyword") {
			seenExtends = true;
			continue;
		}
		if (!seenExtends) continue;
		if (child.type === "quoted_identifier" || child.type === "identifier") {
			return stripQuotes(child.text);
		}
	}
	return undefined;
}
```

- [ ] **Step 5: Wire it into the returned ObjectInfo**

In `src/source/indexer.ts`, in the object literal returned by `indexALFile` (line 1668-1679), after `sourceTableTemporary`:

```ts
		sourceTableTemporary: extractSourceTableTemporary(declNode),
		...(extractExtendsTarget(declNode)
			? { extendsTarget: extractExtendsTarget(declNode) }
			: {}),
```

Note the spread: the field stays absent rather than `undefined` on root objects, which keeps the serialized cache smaller and makes `toBeUndefined()` pass either way.

- [ ] **Step 6: Run tests to verify they pass**

Run: `AI_DISABLED=1 bun test test/source/indexer.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 7: Full verify and commit**

```bash
AI_DISABLED=1 bun run verify
git add src/types/source-index.ts src/source/indexer.ts test/source/indexer.test.ts
git commit -m "$(cat <<'EOF'
feat(indexer): record the object an extension extends

`extractObjectName` returns the first identifier in a declaration, which
for `tableextension 50905 "X" extends Customer` is "X". The target sits
after `extends_keyword` and was never captured, so nothing could resolve
an extension to the object it belongs to.

Captured for every extension type, not just TableExtension: it is one
code path and it is the enabling fact. Only TableExtension has a
consumer today.

Claude-Session: https://claude.ai/code/session_01YLmrajt7dZLmFW24pSQ2Ue
EOF
)"
```

---

### Task 2: Fixtures for the merge

**Files:**
- Create: `test/fixtures/source/TableMergeBase.al`
- Create: `test/fixtures/source/TableMergeExt.al`
- Create: `test/fixtures/source/TableMergeOrphanExt.al`
- Create: `test/fixtures/source/TableMergeAmbigA.al`
- Create: `test/fixtures/source/TableMergeAmbigB.al`
- Modify: `test/cli/commands/source-map.test.ts`, `test/e2e/source-correlation.test.ts`, `test/source/cache.test.ts`, `test/source/indexer.test.ts`, `test/source/indexer-snapshots.test.ts` (fixture-count assertions)

**Interfaces:**
- Consumes: nothing.
- Produces: five fixtures every later task's tests read. Table names and ids are fixed here and referenced by later tasks verbatim:
  - `Table 50970 "Merge Base"` — root. PK key `PK` on `"No."`. Secondary key `ByDate` on `"Posting Date"`. Normal field `Description`. FlowField `"Base Total"` with `CalcFormula = Sum(...)`.
  - `TableExtension 50971 "Merge Base Ext" extends "Merge Base"` — adds normal field `"Ext Code"`, FlowField `"Ext Lookup"` with `CalcFormula = Lookup(...)`, FlowFilter field `"Ext Date Filter"`, key **named `ByDate`** (same name as the root's secondary key, legal) on `"Ext Code"`, and key `ByExtCode2` on `"Ext Code"`.
  - `TableExtension 50972 "Merge Orphan Ext" extends "Merge Absent"` — target declared nowhere. Adds normal field `"Orphan Code"`, FlowField `"Orphan Sum"` with `CalcFormula = Sum(...)`, and key `OrphanKey` on `"Orphan Code"`.
  - `Table 50973 "Merge Ambig"` and `Table 50974 "Merge Ambig"` — same name, different ids.

- [ ] **Step 1: Create the root table fixture**

Create `test/fixtures/source/TableMergeBase.al`:

```al
table 50970 "Merge Base"
{
    fields
    {
        field(1; "No."; Code[20])
        {
        }
        field(2; "Posting Date"; Date)
        {
        }
        field(3; Description; Text[100])
        {
        }
        field(4; "Base Total"; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = Sum("Test Table".Amount where("No." = field("No.")));
        }
    }

    keys
    {
        key(PK; "No.")
        {
            Clustered = true;
        }
        key(ByDate; "Posting Date")
        {
        }
    }
}
```

- [ ] **Step 2: Create the extension fixture**

Create `test/fixtures/source/TableMergeExt.al`:

```al
tableextension 50971 "Merge Base Ext" extends "Merge Base"
{
    fields
    {
        field(50000; "Ext Code"; Code[20])
        {
        }
        field(50001; "Ext Lookup"; Text[100])
        {
            FieldClass = FlowField;
            CalcFormula = Lookup("Test Table".Description where("No." = field("No.")));
        }
        field(50002; "Ext Date Filter"; Date)
        {
            FieldClass = FlowFilter;
        }
    }

    keys
    {
        // Deliberately reuses the root's secondary key NAME. Legal in AL as
        // long as the key holds no base-table fields, so a merge that
        // deduplicates by key name would silently drop this index.
        key(ByDate; "Ext Code")
        {
        }
        key(ByExtCode2; "Ext Code")
        {
        }
    }
}
```

- [ ] **Step 3: Create the orphan extension fixture**

Create `test/fixtures/source/TableMergeOrphanExt.al`:

```al
tableextension 50972 "Merge Orphan Ext" extends "Merge Absent"
{
    fields
    {
        field(50000; "Orphan Code"; Code[20])
        {
        }
        field(50001; "Orphan Sum"; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = Sum("Test Table".Amount where("No." = field("Orphan Code")));
        }
    }

    keys
    {
        key(OrphanKey; "Orphan Code")
        {
        }
    }
}
```

- [ ] **Step 4: Create the two ambiguous roots**

Create `test/fixtures/source/TableMergeAmbigA.al`:

```al
table 50973 "Merge Ambig"
{
    fields
    {
        field(1; "No."; Code[20])
        {
        }
        field(2; AlphaOnly; Text[50])
        {
        }
    }

    keys
    {
        key(PK; "No.")
        {
            Clustered = true;
        }
    }
}
```

Create `test/fixtures/source/TableMergeAmbigB.al`:

```al
table 50974 "Merge Ambig"
{
    fields
    {
        field(1; "Entry No."; Integer)
        {
        }
        field(2; BetaOnly; Text[50])
        {
        }
    }

    keys
    {
        key(PK; "Entry No.")
        {
            Clustered = true;
        }
    }
}
```

- [ ] **Step 5: Run the suite to see the count assertions fail**

Run: `AI_DISABLED=1 bun test test/source/indexer.test.ts test/source/cache.test.ts test/source/indexer-snapshots.test.ts test/cli/commands/source-map.test.ts test/e2e/source-correlation.test.ts`
Expected: FAIL — several `expect(38)` assertions now receive `43`.

- [ ] **Step 6: Update the fixture-count assertions**

Change every `38` to `43` in these exact assertions:

- `test/cli/commands/source-map.test.ts:11` — `expect(index.files.length).toBe(43);`
- `test/cli/commands/source-map.test.ts:12` — `expect(index.objects.size).toBe(43);`
- `test/e2e/source-correlation.test.ts:63` — `expect(result.files.length).toBe(43);`
- `test/source/cache.test.ts` — both `toBe(38)` in "cold cache builds index and stores it"
- `test/source/indexer.test.ts` — both `toBe(38)` in "should build an index from a directory of AL files"
- `test/source/indexer-snapshots.test.ts` — the `it("should index all 38 fixture files")` title, its `expect(index.files).toHaveLength(38)`, and its `expect(index.objects.size).toBe(38)`

Verify none were missed:

```bash
grep -rn "toBe(38)\|toHaveLength(38)\|all 38 fixture" test/
```

Expected: no output.

- [ ] **Step 7: Run tests to verify they pass**

Run: `AI_DISABLED=1 bun run verify`
Expected: 0 fail.

- [ ] **Step 8: Commit**

```bash
git add test/fixtures/source/TableMerge*.al test/cli/commands/source-map.test.ts test/e2e/source-correlation.test.ts test/source/cache.test.ts test/source/indexer.test.ts test/source/indexer-snapshots.test.ts
git commit -m "$(cat <<'EOF'
test(fixtures): add table/extension fixtures for the merge

Five fixtures covering every shape buildTableIndex must handle: a root
with a PK and a secondary key, an extension adding fields and a key that
reuses the root's key NAME (legal, and the case a name-based dedupe would
drop), an orphan extension whose target is declared nowhere, and two
roots sharing a name with different ids.

Claude-Session: https://claude.ai/code/session_01YLmrajt7dZLmFW24pSQ2Ue
EOF
)"
```

---

### Task 3: `ResolvedTable`, `buildTableIndex`, and wiring it into the index and cache

Adding `tables` to `SourceIndex` breaks every literal that constructs one until
the wiring lands, so the type, the builder, the wiring and the `CACHE_VERSION`
bump are one task with one green commit. The builder still gets its own tests.

**Files:**
- Modify: `src/types/source-index.ts` (add `ResolvedTable`, add `tables` to `SourceIndex:1-23`)
- Create: `src/source/table-index.ts`
- Create: `test/source/table-index.test.ts`
- Modify: `src/source/indexer.ts:1716-1727` (the `SourceIndex` literal in `buildSourceIndex`) and its `return index;` at line 1826
- Modify: `src/source/cache.ts:23` (`CACHE_VERSION`), `:38-46` (`SerializedObjectInfo`), `:130-143` (`deserializeIndex`)
- Modify: `test/source/cache.test.ts`

**Interfaces:**
- Consumes: `ObjectInfo.extendsTarget` from Task 1; the fixtures from Task 2.
- Produces:
  - `interface ResolvedTable` exported from `src/types/source-index.ts`, exact shape below.
  - `export function buildTableIndex(objects: Iterable<ObjectInfo>): Map<string, ResolvedTable>` from `src/source/table-index.ts`.
  - A populated `index.tables` on every `SourceIndex`, from a fresh build and from a cache hit alike. Tasks 4-7 read it.

- [ ] **Step 1: Add the type**

In `src/types/source-index.ts`, after `interface ObjectInfo` (which ends at line 82):

```ts
/**
 * One BC table as it exists at runtime: the root `table` declaration plus
 * every indexed `tableextension` that extends it.
 *
 * Positive facts survive a fragment — a field present here IS a field.
 * Negative facts do not: `rootSeen === false` means an absent field proves
 * nothing, and even `rootSeen === true` cannot prove "no key leads with this
 * field", because an extension may live in a dependency app that was never
 * indexed. Nothing here closes the world.
 */
export interface ResolvedTable {
	/**
	 * As declared on the root. With no root, the `extendsTarget` text exactly
	 * as written by the first contributor in (objectId, relative path) order.
	 */
	name: string;
	/** The root's object id. Absent when no root declaration was indexed. */
	objectId?: number;
	/** Root's fields first, then each contributing extension's. */
	fields: TableFieldInfo[];
	/**
	 * Every contributor's keys with provenance. NEVER deduplicated by key
	 * name: a tableextension may legally reuse a base key's name, and
	 * collapsing on it drops a real index.
	 */
	keys: Array<{ key: TableKeyInfo; fromObjectId: number; fromFile: string }>;
	/**
	 * The root `table` declaration was indexed. Does NOT mean every extension
	 * was seen — that is not knowable.
	 */
	rootSeen: boolean;
	/**
	 * More than one distinct root declares this name. Namespaces make that
	 * legal: `Dimension Set Entry` is table 480 in the Base Application and
	 * 36950 in PowerBI Reports. Different tables, so nothing derived from a
	 * merge of them means anything — every consumer treats an ambiguous entry
	 * exactly as it treats an absent table.
	 */
	ambiguous: boolean;
	/**
	 * The root's FIRST key, and only ever the root's. Microsoft's table-keys
	 * documentation: table extensions inherit the base primary key and any key
	 * defined in an extension is a secondary key. BC always loads the primary
	 * key, which is what `incomplete-setloadfields` needs this for.
	 */
	primaryKey?: TableKeyInfo;
	/** Every object that contributed, for evidence text and provenance. */
	sources: Array<{
		objectType: "Table" | "TableExtension";
		objectId: number;
		file: string;
	}>;
}
```

In `interface SourceIndex`, after `objects` (line 12):

```ts
	/**
	 * Resolved per-table picture, keyed on the LOWERCASED table name — AL
	 * identifiers are case-insensitive. Derived from `objects`; never
	 * serialized, always rebuilt.
	 */
	tables: Map<string, ResolvedTable>;
```

- [ ] **Step 2: Write the failing tests**

Create `test/source/table-index.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "path";
import { buildSourceIndex } from "../../src/source/indexer.js";
import { buildTableIndex } from "../../src/source/table-index.js";
import type { ResolvedTable, SourceIndex } from "../../src/types/source-index.js";

const fixturesDir = resolve(import.meta.dir, "../fixtures/source");

let index: SourceIndex;
let tables: Map<string, ResolvedTable>;

beforeAll(async () => {
	index = await buildSourceIndex(fixturesDir);
	tables = buildTableIndex(index.objects.values());
});

describe("buildTableIndex", () => {
	it("merges an extension's fields and keys into its root", () => {
		const t = tables.get("merge base")!;
		expect(t).toBeDefined();
		expect(t.rootSeen).toBe(true);
		expect(t.ambiguous).toBe(false);
		expect(t.objectId).toBe(50970);
		expect(t.name).toBe("Merge Base");

		const fieldNames = t.fields.map((f) => f.name);
		expect(fieldNames).toContain("Description");
		expect(fieldNames).toContain("Ext Code");
		expect(fieldNames).toContain("Ext Lookup");

		expect(t.sources.map((s) => s.objectId).sort()).toEqual([50970, 50971]);
	});

	it("takes primaryKey from the root only", () => {
		const t = tables.get("merge base")!;
		expect(t.primaryKey?.name).toBe("PK");
		expect(t.primaryKey?.fields).toEqual(["No."]);
	});

	it("keeps an extension key whose NAME collides with a root key", () => {
		// AL allows a tableextension to reuse a base key name as long as the
		// key holds no base-table fields. Deduplicating by name drops a real
		// index, and a dropped key that leads with a filtered field
		// manufactures a false unindexed-filter finding.
		const t = tables.get("merge base")!;
		const byDate = t.keys.filter((k) => k.key.name === "ByDate");
		expect(byDate).toHaveLength(2);
		expect(byDate.map((k) => k.fromObjectId).sort()).toEqual([50970, 50971]);
		expect(byDate.find((k) => k.fromObjectId === 50970)!.key.fields).toEqual([
			"Posting Date",
		]);
		expect(byDate.find((k) => k.fromObjectId === 50971)!.key.fields).toEqual([
			"Ext Code",
		]);
	});

	it("builds a fragment entry for an extension whose root is absent", () => {
		const t = tables.get("merge absent")!;
		expect(t).toBeDefined();
		expect(t.rootSeen).toBe(false);
		expect(t.ambiguous).toBe(false);
		expect(t.objectId).toBeUndefined();
		expect(t.primaryKey).toBeUndefined();
		expect(t.name).toBe("Merge Absent");
		expect(t.fields.map((f) => f.name)).toEqual(["Orphan Code", "Orphan Sum"]);
		expect(t.keys).toHaveLength(1);
	});

	it("marks two roots sharing a name as ambiguous", () => {
		const t = tables.get("merge ambig")!;
		expect(t).toBeDefined();
		expect(t.ambiguous).toBe(true);
		expect(t.sources.map((s) => s.objectId).sort()).toEqual([50973, 50974]);
	});

	it("orders contributors deterministically, not by walk order", () => {
		// Roots by relative path, extensions by (objectId, relative path).
		// buildSourceIndex inserts in unsorted Glob.scan order, so a second
		// build from a shuffled object list must produce the same arrays.
		const shuffled = [...index.objects.values()].reverse();
		const again = buildTableIndex(shuffled);
		for (const [key, table] of tables) {
			expect(again.get(key)!.fields.map((f) => f.name)).toEqual(
				table.fields.map((f) => f.name),
			);
			expect(again.get(key)!.keys.map((k) => `${k.fromObjectId}:${k.key.name}`)).toEqual(
				table.keys.map((k) => `${k.fromObjectId}:${k.key.name}`),
			);
			expect(again.get(key)!.rootSeen).toBe(table.rootSeen);
			expect(again.get(key)!.ambiguous).toBe(table.ambiguous);
		}
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `AI_DISABLED=1 bun test test/source/table-index.test.ts`
Expected: FAIL — `Cannot find module '../../src/source/table-index.js'`.

- [ ] **Step 4: Write the builder**

Create `src/source/table-index.ts`:

```ts
import type {
	ObjectInfo,
	ResolvedTable,
	TableFieldInfo,
} from "../types/source-index.js";

/**
 * Build the resolved per-table picture: each root `table` declaration merged
 * with every indexed `tableextension` that extends it.
 *
 * Two ordered passes. Roots first and to completion, so `rootSeen` and
 * `ambiguous` never depend on the order extensions happen to arrive in.
 * Both passes sort their contributors, because `buildSourceIndex` inserts
 * objects in unsorted `Glob.scan` order — relative paths, so the result is
 * identical across machines where absolute paths would not be.
 */
export function buildTableIndex(
	objects: Iterable<ObjectInfo>,
): Map<string, ResolvedTable> {
	const all = [...objects];
	const tables = new Map<string, ResolvedTable>();

	const roots = all
		.filter((o) => o.objectType === "Table")
		.sort((a, b) => a.file.relativePath.localeCompare(b.file.relativePath));

	for (const root of roots) {
		const key = root.objectName.toLowerCase();
		const existing = tables.get(key);
		if (existing) {
			// Two distinct roots with the same name are two different tables —
			// legal because namespaces exist. Nothing derived from merging them
			// means anything, so the entry stops answering questions.
			existing.ambiguous = true;
			existing.sources.push({
				objectType: "Table",
				objectId: root.objectId,
				file: root.file.relativePath,
			});
			continue;
		}
		tables.set(key, {
			name: root.objectName,
			objectId: root.objectId,
			fields: [...root.fields],
			keys: root.keys.map((k) => ({
				key: k,
				fromObjectId: root.objectId,
				fromFile: root.file.relativePath,
			})),
			rootSeen: true,
			ambiguous: false,
			primaryKey: root.keys[0],
			sources: [
				{
					objectType: "Table",
					objectId: root.objectId,
					file: root.file.relativePath,
				},
			],
		});
	}

	const extensions = all
		.filter((o) => o.objectType === "TableExtension" && o.extendsTarget)
		.sort(
			(a, b) =>
				a.objectId - b.objectId ||
				a.file.relativePath.localeCompare(b.file.relativePath),
		);

	for (const ext of extensions) {
		const target = ext.extendsTarget!;
		const key = target.toLowerCase();
		let table = tables.get(key);
		if (!table) {
			table = {
				name: target,
				fields: [],
				keys: [],
				rootSeen: false,
				ambiguous: false,
				sources: [],
			};
			tables.set(key, table);
		}

		// Fields union by name, first wins. The compiler already forbids an
		// extension from redeclaring a base field name, so this never fires on
		// compiling source — it is a defensive tie-break, not a semantic rule.
		const seen = new Set(table.fields.map((f) => f.name.toLowerCase()));
		for (const f of ext.fields as TableFieldInfo[]) {
			if (seen.has(f.name.toLowerCase())) continue;
			seen.add(f.name.toLowerCase());
			table.fields.push(f);
		}

		// Keys are NOT deduplicated. A tableextension may legally reuse a base
		// key's name; collapsing on it drops a real SQL index.
		for (const k of ext.keys) {
			table.keys.push({
				key: k,
				fromObjectId: ext.objectId,
				fromFile: ext.file.relativePath,
			});
		}

		table.sources.push({
			objectType: "TableExtension",
			objectId: ext.objectId,
			file: ext.file.relativePath,
		});
	}

	return tables;
}
```

- [ ] **Step 5: Run the builder tests to verify they pass**

Run: `AI_DISABLED=1 bun test test/source/table-index.test.ts`
Expected: PASS, 6 tests, 0 fail.

Do NOT commit yet — `tsc` still reports `tables` missing on every
`SourceIndex` literal. Steps 6-10 close that in the same commit.

- [ ] **Step 6: Write the failing cache tests**

Add to `test/source/cache.test.ts`, inside the existing `describe("SourceIndexCache", ...)`:

```ts
	test("a warm cache rebuilds the resolved table picture", async () => {
		// `tables` is derived and never serialized, so a cache hit must rebuild
		// it with the same builder — otherwise a cached run and a fresh run
		// disagree on identical source.
		const cache = new SourceIndexCache(cacheDir);
		const cold = await cache.getOrBuild(fixturesDir);
		const warm = await cache.getOrBuild(fixturesDir);
		expect(warm.tables.size).toBe(cold.tables.size);
		const t = warm.tables.get("merge base")!;
		expect(t).toBeDefined();
		expect(t.rootSeen).toBe(true);
		expect(t.fields.map((f) => f.name)).toContain("Ext Code");
		expect(t.keys.filter((k) => k.key.name === "ByDate")).toHaveLength(2);
	});

	test("rejects a cache written before extendsTarget existed", async () => {
		// `extendsTarget` is a NEW serialized ObjectInfo field. A pre-change
		// cache passes its dir hash unchanged, deserializes objects without it,
		// and rebuilds an empty merge — a cached run silently disagreeing with
		// a fresh one. Only the version guard catches that.
		const cache = new SourceIndexCache(cacheDir);
		await cache.getOrBuild(fixturesDir);
		expect(cache.has(fixturesDir)).toBe(true);

		const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const p = resolve(cacheDir, f);
			const entry = JSON.parse(readFileSync(p, "utf-8"));
			entry.version = 3;
			writeFileSync(p, JSON.stringify(entry), "utf-8");
		}
		expect(cache.has(fixturesDir)).toBe(false);
	});
```

Extend the `fs` import at the top of that file to:

```ts
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
```

Run: `AI_DISABLED=1 bun test test/source/cache.test.ts`
Expected: FAIL — `warm.tables` is undefined, and the version-3 entry is still accepted.

- [ ] **Step 7: Populate `tables` in `buildSourceIndex`**

In `src/source/indexer.ts`, add the import at the top of the file, next to the other local imports:

```ts
import { buildTableIndex } from "./table-index.js";
```

In the `SourceIndex` literal inside `buildSourceIndex` (line 1716-1727), add:

```ts
		tables: new Map(),
```

Then replace the final `return index;` (line 1826) with:

```ts
	// Derived from `objects`, so it is built last, once, from the finished set.
	index.tables = buildTableIndex(index.objects.values());

	return index;
}
```

- [ ] **Step 8: Bump the cache version and rebuild `tables` on deserialize**

In `src/source/cache.ts`:

```ts
// 4: ObjectInfo gained `extendsTarget`. A version-3 entry deserializes
// objects without it, so `buildTableIndex` sees zero contributing
// extensions and the whole merge silently vanishes on a cache hit while
// the directory hash still matches.
const CACHE_VERSION = 4;
```

Add `extendsTarget` to `SerializedObjectInfo` so the interface stops lying about what is on disk (`JSON.stringify` already writes every property; the type was merely incomplete):

```ts
interface SerializedObjectInfo {
	objectType: string;
	objectName: string;
	objectId: number;
	file: ALFileInfo;
	procedures: ProcedureInfo[];
	triggers: TriggerInfo[];
	fields: TableFieldInfo[];
	keys: TableKeyInfo[];
	sourceTableTemporary?: boolean;
	extendsTarget?: string;
}
```

In `deserializeIndex`, build the objects map first and derive `tables` from it:

```ts
function deserializeIndex(serialized: SerializedIndex): SourceIndex {
	const objects = new Map(serialized.objects);
	return {
		files: serialized.files,
		objects,
		procedures: new Map(serialized.procedures),
		triggers: new Map(serialized.triggers),
		// Derived data, never serialized — rebuilt with the SAME builder
		// buildSourceIndex uses, so a cache hit and a fresh build cannot drift.
		tables: buildTableIndex(objects.values()),
		// A cached index was written from a successful run; failures are a
		// property of the run, not of the cache.
		failedFiles: [],
		eventCatalog: serialized.eventCatalog ?? {
			publishers: [],
			subscribers: [],
		},
	};
}
```

Add the import at the top of `src/source/cache.ts`:

```ts
import { buildTableIndex } from "./table-index.js";
```

- [ ] **Step 9: Fix every other `SourceIndex` literal**

Run: `bunx tsc --noEmit`

Every error will be `Property 'tables' is missing in type '{ ... }' but required in type 'SourceIndex'`. Add `tables: new Map(),` to each reported literal. Expect these to be test helpers and other callers that construct an index by hand; add the field, do not make it optional.

Re-run until clean:

```bash
bunx tsc --noEmit
```

Expected: no output.

- [ ] **Step 10: Full verify and commit**

```bash
AI_DISABLED=1 bun run verify
git add -A src test
git commit -m "$(cat <<'EOF'
feat(source): resolve a table from its root plus every extension

buildTableIndex merges each root `table` declaration with every indexed
`tableextension` that extends it, keyed on the lowercased table name.

Keys carry provenance and are never deduplicated by name: Microsoft's
table-keys docs allow a tableextension to reuse a base key name as long
as the key holds no base-table fields, and dropping one manufactures the
false unindexed-filter finding this whole change exists to remove.

`primaryKey` comes only from the root — an extension key is a secondary
key by definition, so a fragment has no primary key to know.

Two roots sharing a name are two different tables (namespaces make that
legal; `Dimension Set Entry` is 480 in BaseApp and 36950 in PowerBI
Reports). Such an entry is marked ambiguous and answers nothing.

`buildSourceIndex` builds `index.tables` once from the finished object
set, and `deserializeIndex` rebuilds it with the SAME builder rather than
serializing it, so a cache hit and a fresh build cannot drift.

CACHE_VERSION 3 -> 4. `extendsTarget` is a new serialized ObjectInfo
field: without the bump, a cache written before this change still passes
both its version check and its directory hash, deserializes objects
without the target, and rebuilds an empty merge — a cached run silently
producing different findings from a fresh one on identical source.

Claude-Session: https://claude.ai/code/session_01YLmrajt7dZLmFW24pSQ2Ue
EOF
)"
```

---

### Task 4: `table-graph` reads the resolved table

**Files:**
- Modify: `src/source/table-graph.ts:7-44`
- Test: `test/source/table-graph.test.ts`

**Interfaces:**
- Consumes: `index.tables` from Task 3.
- Produces: no new exports. `buildTableRelationGraph`'s signature is unchanged.

Background: today the function walks `index.objects`, accepts both `Table` and `TableExtension`, and emits `fromTable: obj.objectName`. For a tableextension that is the *extension's* name, so every extension-declared relation names a table that does not exist.

- [ ] **Step 1: Write the failing test**

Add to `test/source/table-graph.test.ts`, inside `describe("buildTableRelationGraph", ...)`:

```ts
	test("attributes an extension's relation to the base table, not the extension", () => {
		// tableextension 50971 "Merge Base Ext" extends "Merge Base" declares a
		// Lookup FlowField. The relation belongs to "Merge Base"; emitting
		// "Merge Base Ext" names a table that does not exist.
		const relations = buildTableRelationGraph(sourceIndex);
		expect(
			relations.find((r) => r.fromTable === "Merge Base Ext"),
		).toBeUndefined();
		const rel = relations.find(
			(r) => r.fromTable === "Merge Base" && r.fromField === "Ext Lookup",
		);
		expect(rel).toBeDefined();
		expect(rel!.relationType).toBe("CalcFormula");
		expect(rel!.fromTableId).toBe(50970);
	});

	test("emits fromTableId 0 for a table with no indexed root", () => {
		// "Merge Absent" exists only as the target of an orphan extension, so
		// there is no root id to name. 0 is what this index already uses for
		// objects with no id of their own.
		const relations = buildTableRelationGraph(sourceIndex);
		const rel = relations.find(
			(r) => r.fromTable === "Merge Absent" && r.fromField === "Orphan Sum",
		);
		expect(rel).toBeDefined();
		expect(rel!.fromTableId).toBe(0);
	});

	test("emits nothing for an ambiguous table name", () => {
		// Two roots named "Merge Ambig" are two different tables; a merged
		// relation from them would describe neither.
		const relations = buildTableRelationGraph(sourceIndex);
		expect(relations.find((r) => r.fromTable === "Merge Ambig")).toBeUndefined();
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `AI_DISABLED=1 bun test test/source/table-graph.test.ts`
Expected: FAIL — the first test finds a `"Merge Base Ext"` relation.

- [ ] **Step 3: Rewrite the loop**

Replace `src/source/table-graph.ts` lines 7-44 (the whole `buildTableRelationGraph` body) with:

```ts
export function buildTableRelationGraph(
	index: SourceIndex,
): TableRelationInfo[] {
	const relations: TableRelationInfo[] = [];

	// Reads the RESOLVED table, not the parsed objects. Walking objects
	// emitted `fromTable: obj.objectName`, which for a tableextension is the
	// extension's own name — every extension-declared relation was attributed
	// to a table that does not exist.
	for (const table of index.tables.values()) {
		// Two roots sharing a name are two different tables; a relation merged
		// across them describes neither.
		if (table.ambiguous) continue;

		// `fromTableId` is a required number and there is no root id to give
		// when only extensions were indexed. 0 is what this index already uses
		// for objects with no id of their own (Interface_0, ControlAddIn_0);
		// the extension's own id would name the wrong object.
		const fromTableId = table.objectId ?? 0;

		for (const field of table.fields) {
			if (field.tableRelationTarget) {
				relations.push({
					fromTable: table.name,
					fromTableId,
					fromField: field.name,
					toTable: field.tableRelationTarget,
					relationType: "TableRelation",
					line: field.line,
				});
			}

			if (field.calcFormulaTable) {
				relations.push({
					fromTable: table.name,
					fromTableId,
					fromField: field.name,
					toTable: field.calcFormulaTable,
					relationType: "CalcFormula",
					line: field.line,
				});
			}
		}
	}

	return relations;
}
```

`ObjectInfo` is no longer referenced by this function — remove it from the import at line 1 if `tsc` reports it unused.

- [ ] **Step 4: Run tests to verify they pass**

Run: `AI_DISABLED=1 bun test test/source/table-graph.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Full verify and commit**

```bash
AI_DISABLED=1 bun run verify
git add src/source/table-graph.ts test/source/table-graph.test.ts
git commit -m "$(cat <<'EOF'
fix(table-graph): attribute an extension's relations to the base table

buildTableRelationGraph walked index.objects, accepted TableExtension,
and emitted `fromTable: obj.objectName` — which for a tableextension is
the extension's own name. Every extension-declared TableRelation and
CalcFormula edge named a table that does not exist.

It now walks the resolved table picture. A table with no indexed root
emits `fromTableId: 0`, the value this index already uses for objects
with no id of their own; the extension's id would name the wrong object.
An ambiguous name emits nothing, since a relation merged across two
different same-named tables describes neither.

Claude-Session: https://claude.ai/code/session_01YLmrajt7dZLmFW24pSQ2Ue
EOF
)"
```

---

### Task 5: `calcfields-in-loop` severity, with the two fragment fences

**Files:**
- Modify: `src/source/source-patterns.ts:124-162` (`resolveCalcFields`) and the `calcFieldFactSentence` call site
- Test: `test/source/source-patterns.test.ts`

**Interfaces:**
- Consumes: `index.tables` from Task 3.
- Produces: no signature change. `resolveCalcFields` keeps returning
  `TableFieldInfo[] | undefined`; the new fences return `undefined`, which
  `calcFieldSeverity` already maps to the conservative `critical` and which
  already suppresses `calcFieldFactSentence`. **No call site changes.**

Background: `calcFieldSeverity(undefined)` returns the conservative `critical`. Two existing paths would newly downgrade off a fragment:

- bare `CalcFields()` falls back to *every* FlowField on the table — on a fragment that set is not the runtime set
- a partially-resolved argument list returns the resolved subset when `resolved.length > 0`, so `CalcFields(ExtLookup, BaseSum)` downgrades on `ExtLookup` alone

- [ ] **Step 1: Write the failing tests**

Add a fixture codeunit. Create `test/fixtures/source/CodeUnitCalcMerge.al`:

```al
codeunit 50975 "CalcFields Merge Probe"
{
    procedure CalcExtFlowFieldOnRootSeenTable(var Driver: Record "Test Table")
    var
        MergeBase: Record "Merge Base";
    begin
        // "Ext Lookup" is declared by the tableextension. Its CalcFormula is a
        // Lookup, which is cheaper than Sum/Count, so severity may graduate —
        // the root IS indexed, so the picture is trustworthy.
        if Driver.FindSet() then
            repeat
                MergeBase.CalcFields("Ext Lookup");
            until Driver.Next() = 0;
    end;

    procedure BareCalcFieldsOnFragment(var Driver: Record "Test Table")
    var
        Absent: Record "Merge Absent";
    begin
        // No arguments: the fallback is "every FlowField on the table", and on
        // a fragment that is not the runtime set.
        if Driver.FindSet() then
            repeat
                Absent.CalcFields();
            until Driver.Next() = 0;
    end;

    procedure PartlyResolvedCalcFieldsOnFragment(var Driver: Record "Test Table")
    var
        Absent: Record "Merge Absent";
    begin
        // "Orphan Sum" resolves from the extension; "Unseen Base Total" does
        // not resolve at all. Downgrading on the resolved subset alone is a
        // guess about the unresolved one.
        if Driver.FindSet() then
            repeat
                Absent.CalcFields("Orphan Sum", "Unseen Base Total");
            until Driver.Next() = 0;
    end;
}
```

Add to `test/source/source-patterns.test.ts`:

```ts
describe("calcfields-in-loop — resolving fields through the merged table", () => {
	function findings(functionName: string) {
		return detectCalcFieldsInLoop(
			[makeMethod({ functionName, objectType: "Codeunit", objectId: 50975 })],
			sourceIndex,
		);
	}

	it("graduates severity off an extension-declared FlowField when the root is seen", () => {
		// "Ext Lookup" lives in tableextension 50971. Before the merge it did
		// not resolve at all and every such finding took the conservative
		// critical default.
		const p = findings("CalcExtFlowFieldOnRootSeenTable");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("warning");
		expect(p[0].suggestion).toMatch(/Lookup/i);
	});

	it("keeps critical for a bare CalcFields() on a fragment", () => {
		// The fallback is "every FlowField on the table"; on a fragment that is
		// a claim about fields nobody has seen.
		const p = findings("BareCalcFieldsOnFragment");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
		expect(p[0].suggestion).not.toMatch(/This table has/i);
	});

	it("keeps critical when only some called fields resolve on a fragment", () => {
		const p = findings("PartlyResolvedCalcFieldsOnFragment");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
		expect(p[0].suggestion).not.toMatch(/This table has/i);
	});
});
```

Bump the fixture counts again — one new file, `43` becomes `44`:

```bash
grep -rn "toBe(43)\|toHaveLength(43)\|all 43 fixture" test/
```

Update every hit, and the `it("should index all 43 fixture files")` title.

- [ ] **Step 2: Run tests to verify they fail**

Run: `AI_DISABLED=1 bun test test/source/source-patterns.test.ts -t "calcfields-in-loop — resolving"`
Expected: FAIL — the first test gets `critical` (the extension field does not resolve), the others may pass for the wrong reason. All three must be green only after Step 3.

- [ ] **Step 3: Rewrite `resolveCalcFields`**

Replace the body of `resolveCalcFields` (`src/source/source-patterns.ts:124-162`) with:

```ts
function resolveCalcFields(
	op: RecordOpInfo,
	variables: VariableInfo[],
	index: SourceIndex,
): TableFieldInfo[] | undefined {
	const recordVariable = op.recordVariable;
	if (!recordVariable) return undefined;

	const variable = variables.find(
		(v) => v.name.toLowerCase() === recordVariable.toLowerCase(),
	);
	// NOTE (documented, not fixed — Issue 6): a Page/Report/XMLport's implicit
	// `Rec` inside a per-row trigger has no `var` declaration, so it never
	// appears in `variables` and this always falls through to `undefined`
	// here. Fails safe (over-severe, never under-severe).
	if (!variable?.isRecord || !variable.tableName) return undefined;

	const table = index.tables.get(variable.tableName.toLowerCase());
	// An ambiguous name is two different tables; nothing read from it is about
	// the one in hand.
	if (!table || table.ambiguous) return undefined;

	const calledFields = op.allFieldArguments;
	if (!calledFields || calledFields.length === 0) {
		// Bare CalcFields() means "every FlowField on the table". On a fragment
		// that set is not the runtime set — an extension's lone Lookup would
		// downgrade the finding while an unseen root Sum is what actually runs.
		if (!table.rootSeen) return undefined;
		const allFlowFields = table.fields.filter((f) => f.calcFormulaType);
		return allFlowFields.length > 0 ? allFlowFields : undefined;
	}

	const calledLower = new Set(calledFields.map((f) => f.toLowerCase()));
	const resolved = table.fields.filter(
		(f) => f.calcFormulaType && calledLower.has(f.name.toLowerCase()),
	);
	if (resolved.length === 0) return undefined;

	// A partially-resolved list on a fragment cannot justify a downgrade: the
	// arguments that did NOT resolve may be the expensive ones.
	const allResolved = resolved.length === calledFields.length;
	if (!table.rootSeen && !allResolved) return undefined;

	return resolved;
}
```

The return type is unchanged: every fence returns `undefined`, which
`calcFieldSeverity` already maps to the conservative `critical` and which
already suppresses `calcFieldFactSentence`. **No call site changes** — verify
that with:

```bash
grep -n "resolveCalcFields(" src/source/source-patterns.ts
```

Each call site should still read `const resolved = resolveCalcFields(...)`
with no unwrapping.

- [ ] **Step 4: Run tests to verify they pass**

Run: `AI_DISABLED=1 bun test test/source/source-patterns.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Full verify and commit**

```bash
AI_DISABLED=1 bun run verify
git add -A src test
git commit -m "$(cat <<'EOF'
fix(calcfields-in-loop): resolve FlowFields through the merged table

resolveCalcFields scanned index.objects for a root Table by exact name,
so a FlowField declared in a tableextension never resolved and every such
finding took the conservative critical default.

It now reads the resolved table, with two fences so the merge cannot
introduce an under-severity false negative on a fragment:

- bare `CalcFields()` falls back to "every FlowField on the table"; on a
  fragment that is a claim about fields nobody has seen, so it returns
  nothing and the finding stays critical
- a partially-resolved argument list may not justify a downgrade on a
  fragment — the arguments that did not resolve may be the expensive ones

Both fences also stop `calcFieldFactSentence` from asserting "This table
has Lookup FlowFields" about a table only seen in fragment.

An ambiguous name resolves to nothing, same as an absent table.

Claude-Session: https://claude.ai/code/session_01YLmrajt7dZLmFW24pSQ2Ue
EOF
)"
```

---

### Task 6: `incomplete-setloadfields` reads the merged table

**Files:**
- Modify: `src/source/source-patterns.ts:768-832`
- Test: `test/source/source-patterns.test.ts`

**Interfaces:**
- Consumes: `index.tables` from Task 3.
- Produces: no new exports.

Behaviour target:

| table | accessed name is in `fields` | not in `fields` |
|---|---|---|
| `rootSeen` | `critical` | skip — paren-less method call |
| fragment | `critical` | `warning` + hedged description |
| absent / ambiguous | — | `warning` + hedged description (today) |

Plus two guards:
- `alwaysLoaded` reads `table.primaryKey` (root only), not `keys[0]` of a merged list
- a FlowField or FlowFilter is never reported as missing — `SetLoadFields` does not accept them, so "add it" would not compile

- [ ] **Step 1: Write the failing tests**

Add a fixture. Create `test/fixtures/source/CodeUnitSetLoadMerge.al`:

```al
codeunit 50976 "SetLoadFields Merge Probe"
{
    procedure ReadsExtensionFieldAfterNarrowing()
    var
        MergeBase: Record "Merge Base";
    begin
        // "Ext Code" is a real field, declared by tableextension 50971. It is
        // not in the SetLoadFields list, so this is a genuine finding — and
        // now a confirmable one.
        MergeBase.SetLoadFields(Description);
        if MergeBase.FindFirst() then
            Message('%1', MergeBase."Ext Code");
    end;

    procedure ReadsExtensionFlowFieldAfterNarrowing()
    var
        MergeBase: Record "Merge Base";
    begin
        // "Ext Lookup" is a FlowField. SetLoadFields does not accept
        // FlowFields, so "add it to SetLoadFields" would not compile.
        MergeBase.SetLoadFields(Description);
        if MergeBase.FindFirst() then
            Message('%1', MergeBase."Ext Lookup");
    end;

    procedure ReadsPrimaryKeyAfterNarrowing()
    var
        MergeBase: Record "Merge Base";
    begin
        // BC always loads the primary key; reading it back is not a forgotten
        // field. The PK must come from the ROOT, not from keys[0] of a merged
        // list that an extension also contributed to.
        MergeBase.SetLoadFields(Description);
        if MergeBase.FindFirst() then
            Message('%1', MergeBase."No.");
    end;

    procedure ReadsFragmentFieldAfterNarrowing()
    var
        Absent: Record "Merge Absent";
    begin
        // "Orphan Code" is confirmed a field by the extension, even though the
        // root was never indexed.
        Absent.SetLoadFields("Orphan Sum");
        if Absent.FindFirst() then
            Message('%1', Absent."Orphan Code");
    end;

    procedure ReadsUnknownNameOnFragmentAfterNarrowing()
    var
        Absent: Record "Merge Absent";
    begin
        // Not in the fragment. Could be an un-narrowed base field or a
        // paren-less base method call — indistinguishable, so the finding
        // stands but stops claiming certainty.
        Absent.SetLoadFields("Orphan Code");
        if Absent.FindFirst() then
            Message('%1', Absent.SomethingUnseen);
    end;
}
```

Add to `test/source/source-patterns.test.ts`:

```ts
describe("incomplete-setloadfields — the merged table picture", () => {
	function findings(functionName: string) {
		return detectIncompleteSetLoadFields(
			[makeMethod({ functionName, objectType: "Codeunit", objectId: 50976 })],
			sourceIndex,
		);
	}

	it("flags an extension-declared field at critical when the root is seen", () => {
		const p = findings("ReadsExtensionFieldAfterNarrowing");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
		expect(p[0].description.toLowerCase()).toContain("ext code");
	});

	it("never reports a FlowField as a missing SetLoadFields entry", () => {
		// SetLoadFields does not accept FlowFields — the suggestion would not
		// compile.
		expect(findings("ReadsExtensionFlowFieldAfterNarrowing")).toHaveLength(0);
	});

	it("does not flag the root's primary key", () => {
		expect(findings("ReadsPrimaryKeyAfterNarrowing")).toHaveLength(0);
	});

	it("flags a confirmed extension field at critical even with no root", () => {
		const p = findings("ReadsFragmentFieldAfterNarrowing");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("critical");
	});

	it("hedges an unconfirmable name on a fragment", () => {
		const p = findings("ReadsUnknownNameOnFragmentAfterNarrowing");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("warning");
		expect(p[0].description).toMatch(/could not be confirmed|not in the index|only .*fragment/i);
	});
});
```

Bump the fixture counts again — one new file, `44` becomes `45`:

```bash
grep -rn "toBe(44)\|toHaveLength(44)\|all 44 fixture" test/
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `AI_DISABLED=1 bun test test/source/source-patterns.test.ts -t "incomplete-setloadfields — the merged"`
Expected: FAIL — the first test finds 0 findings (the extension field does not resolve, so the name is treated as unknown and the whole table is unknown).

- [ ] **Step 3: Replace the resolution block**

In `src/source/source-patterns.ts`, replace lines 768-790 (from `const variable = match.features.variables.find(` through the `alwaysLoaded` loop's closing brace) with:

```ts
				const variable = match.features.variables.find(
					(v) => v.name.toLowerCase() === varLower,
				);
				// The RESOLVED table: the root declaration plus every indexed
				// tableextension. An ambiguous name is two different tables, so
				// it is treated exactly as an absent one.
				const resolvedTable = variable?.tableName
					? index.tables.get(variable.tableName.toLowerCase())
					: undefined;
				const table =
					resolvedTable && !resolvedTable.ambiguous ? resolvedTable : undefined;

				// Fields we can positively confirm. Present on a fragment too —
				// a field that is present IS a field, whether or not the root
				// was indexed.
				const confirmedFields = table
					? new Map(table.fields.map((f) => [f.name.toLowerCase(), f]))
					: undefined;
				// Only a root-seen table can support the NEGATIVE claim "this
				// name is not a field, so it is a paren-less method call". On a
				// fragment an absent name proves nothing.
				const closedFieldList = table?.rootSeen === true;

				// BC ALWAYS loads the primary key — SetLoadFields cannot exclude
				// the fields that identify the record, and SystemId rides along
				// with them. The primary key is the ROOT's first key and only
				// ever the root's: an extension key is a secondary key by BC
				// definition, so a fragment has no primary key to know.
				const alwaysLoaded = new Set<string>(["systemid"]);
				for (const f of table?.primaryKey?.fields ?? []) {
					alwaysLoaded.add(f.toLowerCase());
				}
```

- [ ] **Step 4: Replace the per-access skip rules**

Replace line 810's guard (`if (knownFields && !knownFields.has(fieldLower)) continue;`) with:

```ts
					const confirmed = confirmedFields?.get(fieldLower);
					// SetLoadFields accepts normal fields only. Telling someone
					// to add a FlowField or a FlowFilter to the list produces
					// code that does not compile.
					if (
						confirmed?.calcFormulaType !== undefined ||
						confirmed?.fieldClass?.toLowerCase() === "flowfilter"
					) {
						continue;
					}
					// Not a field of a table whose field list is CLOSED => a
					// paren-less table method call, not a forgotten field. On a
					// fragment the same absence proves nothing, so the finding
					// stands and hedges instead.
					if (closedFieldList && !confirmed) continue;
```

- [ ] **Step 5: Replace the severity and description**

Replace line 822's `severity: knownFields ? "critical" : "warning",` and the two description branches with a decision based on whether every missing field was confirmed:

```ts
				for (const [op, missingFieldsSet] of missingByOp) {
					const missingFields = [...missingFieldsSet];
					const recVar = accessesForVar[0]?.recordVariable ?? varLower;
					// Certainty requires that every reported name be a
					// CONFIRMED field. One unconfirmable name in the list drops
					// the whole finding to warning, because that name may be a
					// paren-less method call rather than a forgotten field.
					const allConfirmed =
						confirmedFields !== undefined &&
						missingFields.every((f) => confirmedFields.has(f));
					patterns.push({
						id: "incomplete-setloadfields",
						severity: allConfirmed ? "critical" : "warning",
						title: `SetLoadFields on ${recVar} in ${method.functionName} is missing accessed fields`,
						description: allConfirmed
							? `SetLoadFields() on ${recVar} loads [${[...op.fields].join(", ")}] but the code later accesses [${missingFields.join(", ")}]. These fields will return default values or cause runtime errors.`
							: `SetLoadFields() on ${recVar} loads [${[...op.fields].join(", ")}] but the code later accesses [${missingFields.join(", ")}]. Table "${variable?.tableName ?? "?"}" is ${table ? "only known from its extensions — its root declaration is not in the index" : "not in the index"}, so these names could not be confirmed to be fields at all — a paren-less call to a table method reads identically here.`,
						impact: method.selfTime,
						involvedMethods: [methodLabel(method)],
						evidence: `SetLoadFields loads ${op.fields.size} field(s), but ${missingFields.length} additional field(s) are accessed: ${missingFields.join(", ")}`,
						suggestion: `Add the missing fields to SetLoadFields: ${missingFields.map((f) => `"${f}"`).join(", ")}`,
					});
				}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `AI_DISABLED=1 bun test test/source/source-patterns.test.ts`
Expected: PASS, 0 fail. If the pre-existing tests "still flags a genuinely missing real field on a known table, at critical" or "drops to warning when the table cannot be resolved" fail, the new `allConfirmed` rule disagrees with them — re-read those tests before changing either side.

- [ ] **Step 7: Full verify and commit**

```bash
AI_DISABLED=1 bun run verify
git add -A src test
git commit -m "$(cat <<'EOF'
fix(incomplete-setloadfields): read the merged table, and stop suggesting FlowFields

The detector resolved a root Table by exact name and was two-way: table
known (critical, and an unknown name is a method call) or unknown
(warning + hedge). A field declared in a tableextension resolved to
nothing, so on any app whose tables are extended the whole table read as
unknown.

It now reads the resolved table and is three-way. A name CONFIRMED to be
a field justifies critical even when only extensions were indexed. The
negative claim — "this name is not a field, so it is a paren-less method
call" — still requires the root, because on a fragment an absent name
proves nothing.

Two guards ride along:

- `alwaysLoaded` reads the ROOT's primary key rather than keys[0] of a
  merged list, which after this change can start with an extension's
  secondary key
- a FlowField or FlowFilter is never reported as a missing entry.
  SetLoadFields does not accept them, so "add it to SetLoadFields" is a
  suggestion that does not compile. Pre-existing for root FlowFields;
  merging extension fields widened it enough to fix here.

An ambiguous table name is treated exactly as an absent one.

Claude-Session: https://claude.ai/code/session_01YLmrajt7dZLmFW24pSQ2Ue
EOF
)"
```

---

### Task 7: `unindexed-filter` reads the merged table, fenced on the root

**Files:**
- Modify: `src/source/source-only-patterns.ts:360-366` (`isKeyLeadingField`) and `:443-460` (the resolution block in `detectUnindexedFilters`)
- Test: `test/source/source-only-patterns.test.ts`

**Interfaces:**
- Consumes: `index.tables` from Task 3.
- Produces: `isKeyLeadingField` changes signature to
  `function isKeyLeadingField(table: ResolvedTable, field: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Add a fixture. Create `test/fixtures/source/CodeUnitFilterMerge.al`:

```al
codeunit 50977 "Unindexed Filter Merge Probe"
{
    procedure FiltersOnExtensionKeyLeadingField()
    var
        MergeBase: Record "Merge Base";
    begin
        // "Ext Code" leads key ByExtCode2, declared by tableextension 50971.
        // Before the merge that key was invisible and this raised a false
        // "no supporting key" finding.
        MergeBase.SetRange("Ext Code", 'X');
        if MergeBase.FindSet() then;
    end;

    procedure FiltersOnExtensionFlowFilter()
    var
        MergeBase: Record "Merge Base";
    begin
        // A FlowFilter is not a table column and has no index by definition,
        // so it cannot cause the scan being warned about. Declared by the
        // extension, so it only resolves through the merge.
        MergeBase.SetRange("Ext Date Filter", 0D);
        if MergeBase.FindSet() then;
    end;

    procedure FiltersOnUnindexedFieldOfRootSeenTable()
    var
        MergeBase: Record "Merge Base";
    begin
        // Description leads no key on the root or on any indexed extension.
        MergeBase.SetRange(Description, 'X');
        if MergeBase.FindSet() then;
    end;

    procedure FiltersOnFragmentTable()
    var
        Absent: Record "Merge Absent";
    begin
        // The root was never indexed, so "no key leads with this field" is
        // unanswerable — an unseen root key could lead with it.
        Absent.SetRange("Orphan Sum", 0);
        if Absent.FindSet() then;
    end;
}
```

Add to `test/source/source-only-patterns.test.ts`:

```ts
describe("unindexed-filter — the merged table picture", () => {
	async function findings(functionName: string) {
		const index = await buildSourceIndex("test/fixtures/source");
		return detectUnindexedFilters(index).filter((p) =>
			p.involvedMethods.some((m) => m.includes(functionName)),
		);
	}

	test("an extension key's leading field suppresses the finding", async () => {
		expect(await findings("FiltersOnExtensionKeyLeadingField")).toHaveLength(0);
	});

	test("an extension FlowFilter suppresses the finding", async () => {
		expect(await findings("FiltersOnExtensionFlowFilter")).toHaveLength(0);
	});

	test("still flags a field no indexed key leads with", async () => {
		const p = await findings("FiltersOnUnindexedFieldOfRootSeenTable");
		expect(p).toHaveLength(1);
		expect(p[0].severity).toBe("warning");
	});

	test("skips a table whose root was never indexed", async () => {
		// "Does NO key lead with this field" cannot be answered from a
		// fragment: an unseen root key could lead with it.
		expect(await findings("FiltersOnFragmentTable")).toHaveLength(0);
	});
});
```

Bump the fixture counts again — one new file, `45` becomes `46`:

```bash
grep -rn "toBe(45)\|toHaveLength(45)\|all 45 fixture" test/
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `AI_DISABLED=1 bun test test/source/source-only-patterns.test.ts -t "unindexed-filter — the merged"`
Expected: FAIL — the first two tests each find 1 finding (the extension's key and FlowFilter are invisible).

- [ ] **Step 3: Change `isKeyLeadingField`**

Replace `src/source/source-only-patterns.ts:360-366` with:

```ts
/** True if `field` is the leading (first) field of any key on `table`. */
function isKeyLeadingField(table: ResolvedTable, field: string): boolean {
	const target = field.toLowerCase();
	return table.keys.some(
		(k) => k.key.fields.length > 0 && k.key.fields[0].toLowerCase() === target,
	);
}
```

Add `ResolvedTable` to the type import at the top of the file, and drop `ObjectInfo` from it if `tsc` reports it unused.

- [ ] **Step 4: Replace the resolution block**

Replace `src/source/source-only-patterns.ts:443-460` (from `// Find the table in the source index` through the FlowFilter check) with:

```ts
				// The RESOLVED table: root declaration plus every indexed
				// tableextension. Before this, an extension's keys and
				// FlowFilter fields were invisible and each produced a false
				// finding.
				const resolved = variable.tableName
					? index.tables.get(variable.tableName.toLowerCase())
					: undefined;
				// An ambiguous name is two different tables; neither answer is
				// about the one in hand.
				if (!resolved || resolved.ambiguous) continue;
				// "Does NO key lead with this field" is a NEGATIVE claim, and a
				// fragment cannot support it — an unseen root key could lead
				// with it. Same skip as the empty-keys case below, so partner
				// apps continue to get no unindexed-filter findings for base
				// tables. This change does not improve that.
				if (!resolved.rootSeen) continue;
				const tableObj = resolved;
				if (tableObj.keys.length === 0) continue;

				// Fields that cannot produce the scan this detector warns about.
				// A FlowFilter is not a table column at all — it parameterises
				// FlowField calculation and has no index by definition — and
				// SystemId carries its own unique index in BC. On a 15,436-file
				// corpus "Date Filter" was the single most-flagged field (450 of
				// 10,352) with SystemId another 147.
				const filteredLower = op.fieldArgument.toLowerCase();
				if (filteredLower === "systemid") continue;
				const fieldDef = tableObj.fields.find(
					(f) => f.name.toLowerCase() === filteredLower,
				);
				if (fieldDef?.fieldClass?.toLowerCase() === "flowfilter") continue;
```

- [ ] **Step 5: Fix the evidence string**

The evidence line at `source-only-patterns.ts:447` builds the key list from `tableObj.keys.map((k) => k.name + "(" + k.fields.join(", ") + ")")`. `keys` entries are now wrappers, so change it to:

```ts
						evidence: `${op.type}("${op.fieldArgument}") at line ${op.line}; keys: ${tableObj.keys.map((k) => k.key.name + "(" + k.key.fields.join(", ") + ")").join(", ")}`,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `AI_DISABLED=1 bun test test/source/source-only-patterns.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 7: Full verify and commit**

```bash
AI_DISABLED=1 bun run verify
git add -A src test
git commit -m "$(cat <<'EOF'
fix(unindexed-filter): see keys and FlowFilters declared in extensions

The detector resolved a root Table by exact name, so a key added by a
tableextension was invisible and a filter on its leading field raised a
false "no supporting key" finding. So did a filter on a FlowFilter field
declared in an extension, which is not a table column at all.

It now reads the resolved table, fenced on the root being indexed:
"does NO key lead with this field" is a negative claim and a fragment
cannot support it, since an unseen root key could lead with it. That
means partner apps continue to get no unindexed-filter findings for base
tables — unchanged, and not improved by this change.

An ambiguous table name is skipped, where the previous linear scan
silently returned whichever same-named table it reached first.

Claude-Session: https://claude.ai/code/session_01YLmrajt7dZLmFW24pSQ2Ue
EOF
)"
```

---

### Task 8: Measure on the corpora and write the CHANGELOG

**Files:**
- Create: `private/audit-merge.ts` (gitignored scratch)
- Modify: `CHANGELOG.md` (the `## Unreleased` section)

**Interfaces:**
- Consumes: everything above.
- Produces: measured before/after numbers, and the CHANGELOG entries.

The tests pin behaviour. This task is what validates it — the repo's own method is that every largest find came from running the tool against real data at scale, not from reading code.

- [ ] **Step 1: Write the audit harness**

Create `private/audit-merge.ts`:

```ts
/**
 * Per-detector finding counts for one corpus. Gitignored scratch, not part
 * of the product.
 */
import { buildSourceIndex } from "../src/source/indexer.js";
import { runSourceOnlyDetectors } from "../src/source/source-only-patterns.js";
import {
	runSourceDetectors,
	syntheticMethodsFromIndex,
} from "../src/source/source-patterns.js";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: bun run private/audit-merge.ts <source-dir>");
	process.exit(1);
}

const t0 = Date.now();
const index = await buildSourceIndex(dir);
const indexMs = Date.now() - t0;

const t1 = Date.now();
const findings = [
	...runSourceOnlyDetectors(index),
	...runSourceDetectors(syntheticMethodsFromIndex(index), index),
];
const detectMs = Date.now() - t1;

const byId = new Map<string, Map<string, number>>();
for (const f of findings) {
	if (!byId.has(f.id)) byId.set(f.id, new Map());
	const sev = byId.get(f.id)!;
	sev.set(f.severity, (sev.get(f.severity) ?? 0) + 1);
}

console.log(`${dir}`);
console.log(
	`  ${index.files.length} files, ${index.objects.size} objects, ${index.tables.size} tables ` +
		`(${[...index.tables.values()].filter((t) => t.rootSeen).length} with a root, ` +
		`${[...index.tables.values()].filter((t) => t.ambiguous).length} ambiguous)`,
);
console.log(`  index ${(indexMs / 1000).toFixed(1)}s, detectors ${(detectMs / 1000).toFixed(1)}s`);
for (const [id, sev] of [...byId].sort(
	(a, b) =>
		[...b[1].values()].reduce((x, y) => x + y, 0) -
		[...a[1].values()].reduce((x, y) => x + y, 0),
)) {
	const total = [...sev.values()].reduce((x, y) => x + y, 0);
	const parts = [...sev].map(([s, n]) => `${s} ${n}`).join(", ");
	console.log(`  ${String(total).padStart(6)}  ${id.padEnd(32)} ${parts}`);
}
```

- [ ] **Step 2: Capture the BEFORE numbers**

The baseline is `master` — this branch was cut from it and every task's work is on the branch. Run the harness from a second worktree so neither tree is disturbed; never `git checkout` in this repo, the CRLF noise makes it expensive.

The harness reads `index.tables`, which does not exist on `master`, so the baseline copy needs that one `console.log` line removed. Write the baseline copy explicitly rather than trying to patch it in place:

```bash
cd /u/Git/al-perf
git worktree add .worktrees/merge-baseline master
cd .worktrees/merge-baseline && bun install
cp /u/Git/al-perf/src/source/tree-sitter-al.wasm src/source/
mkdir -p private
# Same harness, minus the one line that reads index.tables.
grep -v 'index.tables.size' /u/Git/al-perf/.worktrees/ext-table-merge/private/audit-merge.ts \
  | grep -v 'rootSeen\|ambiguous' > private/audit-merge.ts
for d in U:/Git/tree-sitter-al U:/Git/DO U:/Git/DC U:/Git/DocumentOutputRelease; do
  AI_DISABLED=1 bun run private/audit-merge.ts "$d"
done | tee /u/Git/al-perf/.worktrees/ext-table-merge/private/before.txt
```

Confirm the baseline harness actually ran all four corpora before trusting the file — a `grep` that removed too much would make it fail silently.

- [ ] **Step 3: Capture the AFTER numbers**

```bash
cd /u/Git/al-perf/.worktrees/ext-table-merge
for d in U:/Git/tree-sitter-al U:/Git/DO U:/Git/DC U:/Git/DocumentOutputRelease; do
  AI_DISABLED=1 bun run private/audit-merge.ts "$d"
done | tee private/after.txt
diff private/before.txt private/after.txt
```

- [ ] **Step 4: Attribute every moved count**

Three separate causes move numbers, and the report is unreadable if they are pooled:

1. the merge itself
2. the `ambiguous` fence — 16 tables on tree-sitter-al go from "silently pick whichever same-named table the scan reached first" to "answer nothing"
3. **case sensitivity** — every previous lookup compared `o.objectName === variable.tableName` exactly, and the new map is keyed lowercased. AL identifiers are case-insensitive, so this silently fixes a latent bug unrelated to extensions.

For each detector whose count moved, hand-read three findings in each direction against the AL source and record which cause explains them. Write the notes into `private/attribution.md`.

- [ ] **Step 5: Verify both capture kinds**

`calcfields-in-loop` and `incomplete-setloadfields` are source-correlated, so they run on the profile path too. A `.alcpuprofile` is sampling (`kind: 1`) or instrumentation (`positionTicks`), and a fix verified on one is verified on half the product:

```bash
bun run src/cli/index.ts analyze test/fixtures/batch-recorded/profile-1.alcpuprofile --source U:/Git/DocumentOutputRelease -f json 2>/dev/null | bun -e 'const r=JSON.parse(await Bun.stdin.text()); const c={}; for(const p of r.patterns) c[p.id]=(c[p.id]||0)+1; console.log("sampling", JSON.stringify(c));'
bun run src/cli/index.ts analyze U:/Git/bc-mdc-converter/fixtures/instr.reference.alcpuprofile --source U:/Git/DocumentOutputRelease -f json 2>/dev/null | bun -e 'const r=JSON.parse(await Bun.stdin.text()); const c={}; for(const p of r.patterns) c[p.id]=(c[p.id]||0)+1; console.log("instrumentation", JSON.stringify(c));'
```

Both must complete without error and produce findings.

- [ ] **Step 6: Check the stop condition**

If `incomplete-setloadfields` criticals jumped sharply on DO / DC / DocumentOutputRelease, the "fragment + confirmed field = critical" rule is wrong. Stop and re-examine it rather than explaining the number away. A modest rise is expected — extension fields that previously resolved to nothing now confirm.

- [ ] **Step 7: Write the CHANGELOG entries**

In `CHANGELOG.md`, under `## Unreleased`:

Add to **Heads-up before upgrading**:

```markdown
- **The source index now models a table as its root declaration plus every indexed `tableextension`.** Detector counts move in both directions and three separate causes are in play: the merge itself, a new refusal to answer for a table name that two different roots declare (16 of them with the base app in-tree — namespaces make same-name tables legal), and a latent case-sensitivity bug the new lowercased lookup fixes. `SourceIndex` gains a required `tables` field, which breaks any external caller that constructs one, and `CACHE_VERSION` moves 3 → 4, so the first run after upgrading re-parses.
```

Add to **Fixed — detectors that read the evidence wrong**, filling the bracketed numbers from `private/after.txt`:

```markdown
- **A table is not one object, and every detector was reading a fragment of it.** A BC table is a root `table` declaration plus any number of `tableextension` objects from any number of apps. `unindexed-filter` could not see a key or a FlowFilter field an extension declared, `incomplete-setloadfields` could not confirm an extension field is a field, and `calcfields-in-loop` could not resolve an extension FlowField's CalcFormula and fell back to a conservative critical every time. Measured on the 15,436-file corpus: [N] findings moved.
- **`buildTableRelationGraph` attributed every extension's relations to a table that does not exist.** It walked `TableExtension` objects and emitted the extension's own name as `fromTable`, so `tableextension "CDC Sales Line Ext" extends "Sales Line"` produced edges from "CDC Sales Line Ext".
- **`incomplete-setloadfields` suggested adding FlowFields to a `SetLoadFields` list.** `SetLoadFields` does not accept FlowFields or FlowFilters, so the suggested code does not compile.
```

Add to **Fixed — scale and output**:

```markdown
- **Two detectors resolved a table by scanning every object, per record variable.** `detectUnindexedFilters` looped `index.objects.values()` and `detectIncompleteSetLoadFields` spread the whole 15,411-entry map into a fresh array before `.find()`. Both are now a single map lookup: [before]s → [after]s on the 15,436-file corpus.
```

- [ ] **Step 8: Commit**

```bash
AI_DISABLED=1 bun run verify
git add CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(changelog): cover the resolved table picture

Records the measured movement per detector across the four corpora, and
separates the three causes: the merge, the new ambiguous-name refusal,
and the case-sensitivity bug the lowercased lookup fixes.

Claude-Session: https://claude.ai/code/session_01YLmrajt7dZLmFW24pSQ2Ue
EOF
)"
git worktree remove /u/Git/al-perf/.worktrees/merge-baseline
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: `extendsTarget` → Task 1; `ResolvedTable`, the two build passes, ambiguity, key provenance, `primaryKey` from root, ordering, `CACHE_VERSION` and the shared builder → Task 3; the four detector uptakes → Tasks 4-7; measurement, capture-kind verification, the stop condition and the compatibility note → Task 8. The spec's declared non-goals (implicit `Rec` in extension members, namespace-aware resolution, data-audit fields in `alwaysLoaded`) have no task by design.

**Type consistency.** `ResolvedTable.keys` is `Array<{ key, fromObjectId, fromFile }>` everywhere it is read — Task 3 defines it, Task 4 reads `table.fields` only, Task 6 reads `table.primaryKey` and `table.fields`, Task 7 reads `k.key.fields` in both `isKeyLeadingField` and the evidence string. `resolveCalcFields` keeps returning `TableFieldInfo[] | undefined`, so Task 5 changes no call site. `buildTableIndex(objects: Iterable<ObjectInfo>)` is called with `index.objects.values()` and with an array in the Task 3 determinism test — `Iterable` covers both.

**Fixture counts.** Five files in Task 2 (38 → 43), one in Task 5 (43 → 44), one in Task 6 (44 → 45), one in Task 7 (45 → 46). Each task carries its own `grep` to catch a missed assertion.
