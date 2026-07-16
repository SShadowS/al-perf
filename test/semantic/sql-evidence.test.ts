import { describe, expect, test } from "bun:test";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";
import {
	buildSqlByRoutine,
	UNATTRIBUTED_KEY,
} from "../../src/semantic/sql-evidence.js";
import type {
	ProcessedNode,
	ProcessedProfile,
} from "../../src/types/processed.js";

/** Minimal synthetic node factory. */
let nextId = 1;
function makeNode(
	functionName: string,
	opts: {
		objectType?: string;
		objectId?: number;
		objectName?: string;
		hitCount?: number;
		selfTime?: number;
		isBuiltin?: boolean;
	} = {},
): ProcessedNode {
	return {
		id: nextId++,
		callFrame: {
			functionName,
			scriptId: "",
			url: "",
			lineNumber: 0,
			columnNumber: 0,
		},
		applicationDefinition: {
			objectType: opts.objectType ?? "CodeUnit",
			objectId: opts.objectId ?? 414,
			objectName: opts.objectName ?? "Release Sales Document",
		},
		hitCount: opts.hitCount ?? 1,
		children: [],
		depth: 0,
		selfTime: opts.selfTime ?? 100,
		totalTime: opts.selfTime ?? 100,
		selfTimePercent: 0,
		totalTimePercent: 0,
		isBuiltinCodeUnitCall: opts.isBuiltin,
	};
}

function link(parent: ProcessedNode, child: ProcessedNode): void {
	child.parent = parent;
	child.depth = parent.depth + 1;
	parent.children.push(child);
}

function makeProfile(roots: ProcessedNode[]): ProcessedProfile {
	const all: ProcessedNode[] = [];
	const walk = (n: ProcessedNode) => {
		all.push(n);
		n.children.forEach(walk);
	};
	roots.forEach(walk);
	return {
		type: "sampling",
		roots,
		allNodes: all,
		nodeMap: new Map(all.map((n) => [n.id, n])),
		totalDuration: 1000,
		totalSelfTime: 1000,
		activeSelfTime: 1000,
		idleSelfTime: 0,
		maxDepth: 3,
		samplingInterval: 100,
		nodeCount: all.length,
		startTime: 0,
		endTime: 1000,
	};
}

const SQL_A = `SELECT TOP (1) "No_" FROM dbo."CRONUS$Sales Header" WITH(READUNCOMMITTED) WHERE ("No_"='C10')`;
const SQL_A2 = `SELECT TOP (1) "No_" FROM dbo."CRONUS$Sales Header" WITH(READUNCOMMITTED) WHERE ("No_"='C20')`;
const SQL_UPD = `UPDATE dbo."CRONUS$Sales Header" SET "Status"=@0`;

describe("buildSqlByRoutine", () => {
	test("SQL under an AL routine is keyed by that routine; shapes group; sums accumulate", () => {
		const routine = makeNode("PostDocument", {
			objectType: "CodeUnit",
			objectId: 80,
		});
		const sql1 = makeNode(SQL_A, {
			hitCount: 3,
			selfTime: 300,
			objectType: "CodeUnit",
			objectId: 80,
		});
		const sql2 = makeNode(SQL_A2, {
			hitCount: 2,
			selfTime: 200,
			objectType: "CodeUnit",
			objectId: 80,
		});
		link(routine, sql1);
		link(routine, sql2);
		const map = buildSqlByRoutine(makeProfile([routine]));
		const items = map.get("PostDocument_CodeUnit_80");
		expect(items).toBeDefined();
		expect(items!.length).toBe(1); // same shape after literal blanking
		expect(items![0].sampledHitCount).toBe(5);
		expect(items![0].sampledCostUs).toBe(500);
		expect(items![0].operation).toBe("SELECT");
		expect(items![0].table).toBe("Sales Header");
		expect(items![0].readUncommitted).toBe(true);
		expect(items![0].attribution).toBe("object-method"); // SQL node carries a valid appDef object
	});

	test("SQL under a builtin wrapper attributes to the nearest AL ANCESTOR, not the wrapper", () => {
		const routine = makeNode("PostDocument", {
			objectType: "CodeUnit",
			objectId: 80,
		});
		const wrapper = makeNode("Microsoft.Dynamics.Nav.NavRecord.Find", {
			isBuiltin: true,
		});
		const sql = makeNode(SQL_UPD, {
			hitCount: 1,
			selfTime: 50,
			objectType: "",
			objectId: -1,
			objectName: "",
		});
		link(routine, wrapper);
		link(wrapper, sql);
		const map = buildSqlByRoutine(makeProfile([routine]));
		const items = map.get("PostDocument_CodeUnit_80");
		expect(items).toBeDefined();
		expect(items![0].operation).toBe("UPDATE");
		expect(items![0].attribution).toBe("ancestor-fallback"); // appDef invalid -> ancestor object
	});

	test("SQL with NO AL ancestor lands in the unattributed bucket, not dropped", () => {
		const builtinRoot = makeNode("SystemRoot", {
			isBuiltin: true,
			objectType: "",
			objectId: -1,
		});
		const sql = makeNode(SQL_A, {
			hitCount: 1,
			selfTime: 10,
			objectType: "",
			objectId: -1,
			objectName: "",
		});
		link(builtinRoot, sql);
		const map = buildSqlByRoutine(makeProfile([builtinRoot]));
		expect(map.get(UNATTRIBUTED_KEY)?.length).toBe(1);
	});

	test("callee isolation: SQL under a CHILD routine belongs to the child, not the parent", () => {
		const parent = makeNode("Caller", { objectType: "CodeUnit", objectId: 1 });
		const child = makeNode("Callee", { objectType: "CodeUnit", objectId: 2 });
		const sql = makeNode(SQL_A, {
			hitCount: 1,
			selfTime: 10,
			objectType: "CodeUnit",
			objectId: 2,
		});
		link(parent, child);
		link(child, sql);
		const map = buildSqlByRoutine(makeProfile([parent]));
		expect(map.get("Callee_CodeUnit_2")).toBeDefined();
		expect(map.get("Caller_CodeUnit_1")).toBeUndefined();
	});

	test("real BC28 capture: profile-1 yields SQL evidence for real routines", async () => {
		const parsed = await parseProfile(
			"test/fixtures/batch-recorded/profile-1.alcpuprofile",
		);
		const processed = processProfile(parsed);
		const map = buildSqlByRoutine(processed);
		let total = 0;
		for (const items of map.values())
			for (const it of items) total += it.sampledHitCount;
		expect(map.size).toBeGreaterThan(0);
		expect(total).toBeGreaterThan(0);
	});
});
