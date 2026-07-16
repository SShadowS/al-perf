import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";
import {
	attachSqlEvidence,
	buildSqlActivityCorroboration,
	buildSqlByRoutine,
	UNATTRIBUTED_KEY,
} from "../../src/semantic/sql-evidence.js";
import type { ProfileMetadata } from "../../src/types/batch.js";
import type {
	DetectedPattern,
	SqlStatementEvidence,
} from "../../src/types/patterns.js";
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

const REAL_PROFILE = "test/fixtures/batch-recorded/profile-1.alcpuprofile";

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

	// Fixture is gitignored (real capture data); test is local-only by design.
	test.skipIf(!existsSync(REAL_PROFILE))(
		"real BC28 capture: profile-1 yields SQL evidence for real routines",
		async () => {
			const parsed = await parseProfile(REAL_PROFILE);
			const processed = processProfile(parsed);
			const map = buildSqlByRoutine(processed);
			let total = 0;
			for (const items of map.values())
				for (const it of items) total += it.sampledHitCount;
			expect(map.size).toBeGreaterThan(0);
			expect(total).toBeGreaterThan(0);
		},
	);
});

function makePattern(id: string, involvedMethods: string[]): DetectedPattern {
	return {
		id,
		severity: "warning",
		title: id,
		description: "",
		impact: 12345,
		involvedMethods,
		evidence: "",
	};
}

describe("attachSqlEvidence", () => {
	function mapWith(
		key: string,
		items: Partial<SqlStatementEvidence>[],
	): Map<string, SqlStatementEvidence[]> {
		const full = items.map(
			(p, i): SqlStatementEvidence => ({
				text: p.text ?? `SELECT ?${i}`,
				operation: p.operation ?? "SELECT",
				table: p.table ?? "Sales Header",
				extensionAppId: null,
				readUncommitted: false,
				sampledHitCount: p.sampledHitCount ?? 1,
				sampledCostUs: p.sampledCostUs ?? 10,
				attribution: p.attribution ?? "object-method",
			}),
		);
		return new Map([[key, full]]);
	}

	test("attaches matching op-type SQL; impact untouched; sqlRank set", () => {
		const p = makePattern("missing-setloadfields", [
			"PostDocument (CodeUnit 80)",
		]);
		attachSqlEvidence(
			[p],
			mapWith("PostDocument_CodeUnit_80", [
				{ operation: "SELECT", sampledCostUs: 400, sampledHitCount: 4 },
				{ operation: "UPDATE", sampledCostUs: 999 }, // filtered out for this pattern id
			]),
		);
		expect(p.sqlEvidence).toBeDefined();
		expect(p.sqlEvidence!.statements.length).toBe(1);
		expect(p.sqlEvidence!.totalSampledCostUs).toBe(400);
		expect(p.sqlEvidence!.totalSampledHitCount).toBe(4);
		expect(p.sqlEvidence!.provenance).toBe("sampled-estimate");
		expect(p.sqlRank).toBe(400);
		expect(p.impact).toBe(12345); // NEVER mutated
	});

	test("unions across ALL involvedMethods entries and skips SQL-frame labels", () => {
		const p = makePattern("repeated-siblings", [
			"Caller (CodeUnit 1)",
			'SELECT TOP (?) "No_" FROM x (TableData 36)', // SQL frame label -> skipped
		]);
		const map = new Map([
			...mapWith("Caller_CodeUnit_1", [
				{ operation: "SELECT" as const, sampledCostUs: 70 },
			]),
			// Keyed exactly as the SQL-frame label would parse if the
			// isSqlFunctionName guard were missing. A high cost here means a
			// removed guard wrongly pulls this in and reddens the assertion.
			...mapWith('SELECT TOP (?) "No_" FROM x_TableData_36', [
				{ operation: "SELECT" as const, sampledCostUs: 999 },
			]),
		]);
		attachSqlEvidence([p], map);
		expect(p.sqlEvidence!.totalSampledCostUs).toBe(70); // guard removed -> 1069, red
	});

	test("same routine label twice in involvedMethods is not double-counted", () => {
		const p = makePattern("repeated-siblings", [
			"Caller (CodeUnit 1)",
			"Caller (CodeUnit 1)",
		]);
		const map = mapWith("Caller_CodeUnit_1", [
			{ operation: "SELECT" as const, sampledCostUs: 30 },
		]);
		attachSqlEvidence([p], map);
		expect(p.sqlEvidence!.totalSampledCostUs).toBe(30); // seen-Set dedupe removed -> 60, red
	});

	test("union across parent AND child routine entries", () => {
		const p = makePattern("repeated-siblings", [
			"Caller (CodeUnit 1)",
			"Callee (CodeUnit 2)",
		]);
		const map = new Map([
			...mapWith("Caller_CodeUnit_1", [{ sampledCostUs: 30 }]),
			...mapWith("Callee_CodeUnit_2", [{ sampledCostUs: 50 }]),
		]);
		attachSqlEvidence([p], map);
		expect(p.sqlEvidence!.totalSampledCostUs).toBe(80);
	});

	test("op-type filters: modify-in-loop takes UPDATE only; calcfields needs aggregate", () => {
		const upd = makePattern("modify-in-loop", ["M (CodeUnit 9)"]);
		attachSqlEvidence(
			[upd],
			mapWith("M_CodeUnit_9", [
				{ operation: "UPDATE", sampledCostUs: 5 },
				{ operation: "SELECT", sampledCostUs: 500 },
			]),
		);
		expect(upd.sqlEvidence!.statements[0].operation).toBe("UPDATE");
		expect(upd.sqlEvidence!.totalSampledCostUs).toBe(5);

		const calc = makePattern("calcfields-in-loop", ["M (CodeUnit 9)"]);
		attachSqlEvidence(
			[calc],
			mapWith("M_CodeUnit_9", [
				{ operation: "SELECT", text: "SELECT SUM(?) FROM t", sampledCostUs: 8 },
				{ operation: "SELECT", text: "SELECT a FROM t", sampledCostUs: 9 },
				{
					operation: "COUNT",
					text: "SELECT COUNT(*) FROM t",
					sampledCostUs: 3,
				},
			]),
		);
		expect(calc.sqlEvidence!.totalSampledCostUs).toBe(11); // SUM + COUNT rows only
	});

	test("unknown pattern id -> no evidence (not in the map = no signal)", () => {
		const p = makePattern("deep-call-stack", ["M (CodeUnit 9)"]);
		attachSqlEvidence([p], mapWith("M_CodeUnit_9", [{ sampledCostUs: 100 }]));
		expect(p.sqlEvidence).toBeUndefined();
		expect(p.sqlRank).toBeUndefined();
	});

	test("no matching SQL -> silent (fields absent)", () => {
		const p = makePattern("missing-setloadfields", ["Other (CodeUnit 7)"]);
		attachSqlEvidence([p], mapWith("M_CodeUnit_9", [{ sampledCostUs: 100 }]));
		expect(p.sqlEvidence).toBeUndefined();
	});

	test("rank-inversion pin: totals from FULL set, statements truncated to top-5", () => {
		const p = makePattern("missing-setloadfields", ["M (CodeUnit 9)"]);
		const six = Array.from({ length: 6 }, (_, i) => ({
			operation: "SELECT" as const,
			text: `SELECT col${i} FROM t${i}`,
			sampledCostUs: 10,
			sampledHitCount: 1,
		}));
		attachSqlEvidence([p], mapWith("M_CodeUnit_9", six));
		expect(p.sqlEvidence!.statements.length).toBe(5); // display truncation
		expect(p.sqlEvidence!.totalSampledCostUs).toBe(60); // FULL set — 6x10, not 5x10
		expect(p.sqlRank).toBe(60);
	});

	test("attribution derives: all object-method -> object-method; mixed -> mixed", () => {
		const p = makePattern("missing-setloadfields", ["M (CodeUnit 9)"]);
		attachSqlEvidence(
			[p],
			mapWith("M_CodeUnit_9", [
				{
					attribution: "object-method",
					sampledCostUs: 10,
					text: "SELECT a FROM t",
				},
				{
					attribution: "ancestor-fallback",
					sampledCostUs: 5,
					text: "SELECT b FROM u",
				},
			]),
		);
		expect(p.sqlEvidence!.attribution).toBe("mixed");
	});

	test("mutation guard: only sqlEvidence/sqlRank change", () => {
		const p = makePattern("missing-setloadfields", ["M (CodeUnit 9)"]);
		const before = structuredClone(p);
		attachSqlEvidence([p], mapWith("M_CodeUnit_9", [{ sampledCostUs: 10 }]));
		const after = structuredClone(p);
		delete (after as Record<string, unknown>).sqlEvidence;
		delete (after as Record<string, unknown>).sqlRank;
		expect(after).toEqual(before);
	});
});

describe("buildSqlActivityCorroboration", () => {
	// clientSessionId is typed `number` in src/types/batch.ts (not the string
	// placeholder in the brief) — fixed here to match the actual type exactly.
	const meta: ProfileMetadata = {
		activityId: "x",
		activityType: "WebClient",
		activityDescription: "test",
		startTime: "2026-03-05T13:21:41.453Z",
		activityDuration: 11945,
		alExecutionDuration: 7023,
		sqlCallDuration: 382,
		sqlCallCount: 1381,
		httpCallDuration: 0,
		httpCallCount: 0,
		userName: "T",
		clientSessionId: 42,
		scheduleDescription: "s",
	};

	test("measured beside sampled; each SQL shape summed once; NO residual field", () => {
		const map = new Map([
			["A_CodeUnit_1", [{ sampledCostUs: 300 } as never]],
			["B_CodeUnit_2", [{ sampledCostUs: 200 } as never]],
			["", [{ sampledCostUs: 50 } as never]], // unattributed still counts in the total
		]);
		const c = buildSqlActivityCorroboration(map as never, meta);
		expect(c.measuredSqlCount).toBe(1381);
		expect(c.measuredSqlDurationMs).toBe(382);
		expect(c.sampledAttributedCostUs).toBe(550);
		expect(c.activityDurationMs).toBe(11945);
		expect("unaccountedMs" in c).toBe(false); // fields overlap — no subtraction, ever
	});
});
