import { describe, expect, it } from "bun:test";
import {
	matchAllToSource,
	matchExactToSource,
	matchToSource,
} from "../../src/source/locator.js";
import type {
	ProcedureInfo,
	SourceIndex,
	TriggerInfo,
} from "../../src/types/source-index.js";

function makeProcedure(overrides: Partial<ProcedureInfo>): ProcedureInfo {
	return {
		name: "TestProc",
		objectType: "Codeunit",
		objectName: "Test",
		objectId: 50100,
		file: "CodeUnit50100.al",
		lineStart: 10,
		lineEnd: 20,
		features: {
			loops: [],
			recordOps: [],
			recordOpsInLoops: [],
			nestingDepth: 0,
		},
		...overrides,
	};
}

function makeIndex(
	procs: ProcedureInfo[],
	trigs: TriggerInfo[] = [],
): SourceIndex {
	const procedures = new Map<string, ProcedureInfo[]>();
	for (const p of procs) {
		const key = p.name.toLowerCase();
		const list = procedures.get(key) ?? [];
		list.push(p);
		procedures.set(key, list);
	}
	const triggers = new Map<string, TriggerInfo[]>();
	for (const t of trigs) {
		const key = t.name.toLowerCase();
		const list = triggers.get(key) ?? [];
		list.push(t);
		triggers.set(key, list);
	}
	return {
		files: [],
		procedures,
		triggers,
		objects: new Map(),
		// tsconfig.json excludes test/, so tsc cannot catch a SourceIndex
		// literal that is missing a required field. Kept complete by hand.
		tables: new Map(),
		eventCatalog: { publishers: [], subscribers: [] },
		failedFiles: [],
	};
}

describe("matchToSource", () => {
	it("should match by functionName + objectId", () => {
		const proc = makeProcedure({ name: "DoWork", objectId: 80 });
		const index = makeIndex([proc]);
		const result = matchToSource("DoWork", "Codeunit", 80, index);
		expect(result).not.toBeNull();
		expect(result!.name).toBe("DoWork");
		expect(result!.objectId).toBe(80);
	});

	it("should match by name only when single candidate", () => {
		const proc = makeProcedure({ name: "UniqueProc", objectId: 50100 });
		const index = makeIndex([proc]);
		const result = matchToSource("UniqueProc", "Codeunit", 99999, index);
		expect(result).not.toBeNull();
		expect(result!.name).toBe("UniqueProc");
	});

	it("should return null when no match found", () => {
		const index = makeIndex([]);
		const result = matchToSource("NonExistent", "Codeunit", 80, index);
		expect(result).toBeNull();
	});

	it("should disambiguate by objectType when multiple candidates", () => {
		const proc1 = makeProcedure({
			name: "Init",
			objectType: "Codeunit",
			objectId: 1,
		});
		const proc2 = makeProcedure({
			name: "Init",
			objectType: "Table",
			objectId: 2,
		});
		const index = makeIndex([proc1, proc2]);
		const result = matchToSource("Init", "Table", 2, index);
		expect(result).not.toBeNull();
		expect(result!.objectType).toBe("Table");
		expect(result!.objectId).toBe(2);
	});

	it("should match triggers (OnRun, OnInsert, etc.)", () => {
		const trigger: TriggerInfo = {
			name: "OnRun",
			objectType: "Codeunit",
			objectName: "Test",
			objectId: 80,
			file: "CodeUnit80.al",
			lineStart: 5,
			lineEnd: 15,
			features: {
				loops: [],
				recordOps: [],
				recordOpsInLoops: [],
				nestingDepth: 0,
			},
		};
		const index = makeIndex([], [trigger]);
		const result = matchToSource("OnRun", "Codeunit", 80, index);
		expect(result).not.toBeNull();
		expect(result!.name).toBe("OnRun");
	});

	it("should be case-insensitive", () => {
		const proc = makeProcedure({ name: "DoWork", objectId: 80 });
		const index = makeIndex([proc]);
		const result = matchToSource("dowork", "Codeunit", 80, index);
		expect(result).not.toBeNull();
	});
});

describe("matchAllToSource — overload detection", () => {
	it("returns empty array when no candidate found", () => {
		const index = makeIndex([]);
		const result = matchAllToSource("NonExistent", "Codeunit", 80, index);
		expect(result).toEqual([]);
	});

	it("returns a single-element array for an unambiguous match", () => {
		const proc = makeProcedure({ name: "DoWork", objectId: 80 });
		const index = makeIndex([proc]);
		const result = matchAllToSource("DoWork", "Codeunit", 80, index);
		expect(result.length).toBe(1);
		expect(result[0].name).toBe("DoWork");
	});

	it("returns ≥2 elements when multiple overloads share (functionName, objectId)", () => {
		// Two procedures with the same name and objectId (overloads — same object)
		const proc1 = makeProcedure({
			name: "Calculate",
			objectId: 50100,
			objectType: "Codeunit",
		});
		const proc2 = makeProcedure({
			name: "Calculate",
			objectId: 50100,
			objectType: "Codeunit",
			lineStart: 30, // different line to distinguish them
			lineEnd: 40,
		});
		const index = makeIndex([proc1, proc2]);
		const result = matchAllToSource("Calculate", "Codeunit", 50100, index);
		expect(result.length).toBeGreaterThanOrEqual(2);
	});

	it("matchToSource still returns exactly one result (first of matchAllToSource)", () => {
		const proc1 = makeProcedure({
			name: "Calculate",
			objectId: 50100,
			lineStart: 10,
			lineEnd: 20,
		});
		const proc2 = makeProcedure({
			name: "Calculate",
			objectId: 50100,
			lineStart: 30,
			lineEnd: 40,
		});
		const index = makeIndex([proc1, proc2]);
		const single = matchToSource("Calculate", "Codeunit", 50100, index);
		const all = matchAllToSource("Calculate", "Codeunit", 50100, index);
		// matchToSource returns the first element of matchAllToSource
		expect(single).toBe(all[0]);
		expect(all.length).toBeGreaterThanOrEqual(2);
	});

	it("is case-insensitive (same as matchToSource)", () => {
		const proc = makeProcedure({ name: "DoWork", objectId: 80 });
		const index = makeIndex([proc]);
		const result = matchAllToSource("dowork", "Codeunit", 80, index);
		expect(result.length).toBe(1);
		expect(result[0].name).toBe("DoWork");
	});
});

describe("matchAllToSource — object-type collision (id is unique only per type)", () => {
	it("returns only the candidate whose object type matches", () => {
		const cuRefresh = makeProcedure({
			name: "Refresh",
			objectType: "Codeunit",
			objectId: 50999,
			objectName: "Collision Handler",
		});
		const tblRefresh = makeProcedure({
			name: "Refresh",
			objectType: "Table",
			objectId: 50999,
			objectName: "Collision Buffer",
		});
		const index = makeIndex([cuRefresh, tblRefresh]);

		const matches = matchAllToSource("Refresh", "Codeunit", 50999, index);

		expect(matches).toHaveLength(1);
		expect(matches[0].objectType).toBe("Codeunit");
	});

	it("is case-insensitive on the object type (CodeUnit vs Codeunit)", () => {
		const cuRefresh = makeProcedure({
			name: "Refresh",
			objectType: "Codeunit",
			objectId: 50999,
		});
		const tblRefresh = makeProcedure({
			name: "Refresh",
			objectType: "Table",
			objectId: 50999,
		});
		const index = makeIndex([cuRefresh, tblRefresh]);

		// Profiles sometimes carry "CodeUnit"; the index carries "Codeunit".
		expect(matchAllToSource("Refresh", "CodeUnit", 50999, index)).toHaveLength(
			1,
		);
	});

	it("falls back to the id-only set when NO candidate type matches", () => {
		// Preserves today's recall: an unrecognized/absent caller type must not
		// silently drop a real match. A SECOND same-named candidate at a
		// different objectId is deliberate: with only one total candidate, step
		// 3's "single candidate regardless of objectId" rule would mask the
		// id-only fallback (step 2) being removed entirely. With two total
		// candidates, only the id-only fallback can narrow correctly to the one
		// whose objectId actually matches.
		const cuRefresh = makeProcedure({
			name: "Refresh",
			objectType: "Codeunit",
			objectId: 50999,
		});
		const otherRefresh = makeProcedure({
			name: "Refresh",
			objectType: "Codeunit",
			objectId: 60000,
		});
		const index = makeIndex([cuRefresh, otherRefresh]);

		const matches = matchAllToSource("Refresh", "Query", 50999, index);
		expect(matches).toHaveLength(1);
		expect(matches[0].objectType).toBe("Codeunit");
		expect(matches[0].objectId).toBe(50999);
	});

	it("still returns genuine same-type overloads (two Codeunit 50999 Refresh)", () => {
		// The overload case step 1 was designed for must survive the fix.
		const a = makeProcedure({
			name: "Refresh",
			objectType: "Codeunit",
			objectId: 50999,
			lineStart: 10,
		});
		const b = makeProcedure({
			name: "Refresh",
			objectType: "Codeunit",
			objectId: 50999,
			lineStart: 40,
		});
		const index = makeIndex([a, b]);

		expect(matchAllToSource("Refresh", "Codeunit", 50999, index)).toHaveLength(
			2,
		);
	});
});

describe("matchExactToSource", () => {
	// ProcessRecords exists once, in Codeunit 50100. LookupRecords shares that
	// id under a different TYPE — the pair that separates an id-only rule from
	// a type+id one.
	const index = makeIndex([
		makeProcedure({
			name: "ProcessRecords",
			objectType: "Codeunit",
			objectId: 50100,
		}),
		makeProcedure({
			name: "LookupRecords",
			objectType: "Table",
			objectId: 50100,
		}),
	]);

	it("resolves a routine when type and id both match", () => {
		const m = matchExactToSource("ProcessRecords", "Codeunit", 50100, index);
		expect(m.length).toBe(1);
		expect(m[0].objectId).toBe(50100);
	});

	it("tolerates the profile's object-type casing", () => {
		// Profiles say "CodeUnit"; the index says "Codeunit". Without
		// canonicalObjectType this fence rejects every real match, and the
		// feature depending on it goes permanently silent while looking like it
		// works.
		expect(
			matchExactToSource("ProcessRecords", "CodeUnit", 50100, index).length,
		).toBe(1);
	});

	it("refuses a name-only match that matchAllToSource accepts", () => {
		// Asked about Codeunit 99999, matchAllToSource falls through to its
		// step-3 single-candidate rule and returns the WRONG object's routine.
		// Verified against the real fixture index too, not just this synthetic
		// one. matchExactToSource must return nothing: that is why it exists.
		expect(
			matchAllToSource("ProcessRecords", "Codeunit", 99999, index).length,
		).toBe(1);
		expect(
			matchExactToSource("ProcessRecords", "Codeunit", 99999, index).length,
		).toBe(0);
	});

	it("refuses a right-id, wrong-type match", () => {
		expect(
			matchAllToSource("LookupRecords", "Codeunit", 50100, index).length,
		).toBe(1);
		expect(
			matchExactToSource("LookupRecords", "Codeunit", 50100, index).length,
		).toBe(0);
	});

	it("returns nothing for an unknown name", () => {
		expect(
			matchExactToSource("NoSuchRoutineAnywhere", "Codeunit", 50100, index)
				.length,
		).toBe(0);
	});
});
