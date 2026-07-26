import type { ObjectInfo, ResolvedTable } from "../types/source-index.js";

/**
 * Codepoint order. `localeCompare` follows the host locale, which makes the
 * merge order machine-dependent — see `buildTableIndex`'s note.
 */
function byPath(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the resolved per-table picture: each root `table` declaration merged
 * with every indexed `tableextension` that extends it.
 *
 * Two ordered passes. Roots first and to completion, so `rootSeen` and
 * `ambiguous` never depend on the order extensions happen to arrive in.
 * Both passes sort their contributors, because `buildSourceIndex` inserts
 * objects in unsorted `Glob.scan` order — by RELATIVE path, so a workspace
 * checked out at a different absolute path still merges identically, and by
 * CODEPOINT rather than `localeCompare`, which follows the host locale:
 * `"aa.al".localeCompare("z.al")` is -1 under `en` and +1 under `da`, so two
 * machines with different locales would order the same roots differently.
 */
export function buildTableIndex(
	objects: Iterable<ObjectInfo>,
): Map<string, ResolvedTable> {
	const all = [...objects];
	const tables = new Map<string, ResolvedTable>();

	const roots = all
		.filter((o) => o.objectType === "Table")
		.sort((a, b) => byPath(a.file.relativePath, b.file.relativePath));

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
				byPath(a.file.relativePath, b.file.relativePath),
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

		// Fields union by name, first wins — the ROOT's declaration wins over an
		// extension's, and an earlier extension over a later one.
		//
		// Not a defensive tie-break: this branch fires 168 times on the BC base
		// app. AL normally rejects an extension redeclaring a field the table
		// already has, but the move-a-field-to-another-app idiom suppresses that
		// with `MovedFrom` plus `#pragma warning disable AS0125`, so root and
		// extension both carry it — `ReturnReasonExt` and `Return Reason` each
		// declare `field(3; "Default Location Code")` with the same
		// TableRelation. Without the dedup that is two fields and, downstream,
		// two identical relation graph edges.
		const seen = new Set(table.fields.map((f) => f.name.toLowerCase()));
		for (const f of ext.fields) {
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
