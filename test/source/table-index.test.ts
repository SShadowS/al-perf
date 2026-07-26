import { beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "path";
import { buildSourceIndex } from "../../src/source/indexer.js";
import { buildTableIndex } from "../../src/source/table-index.js";
import type {
	ResolvedTable,
	SourceIndex,
} from "../../src/types/source-index.js";

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
			expect(
				again.get(key)!.keys.map((k) => `${k.fromObjectId}:${k.key.name}`),
			).toEqual(table.keys.map((k) => `${k.fromObjectId}:${k.key.name}`));
			expect(again.get(key)!.rootSeen).toBe(table.rootSeen);
			expect(again.get(key)!.ambiguous).toBe(table.ambiguous);
		}
	});
});
