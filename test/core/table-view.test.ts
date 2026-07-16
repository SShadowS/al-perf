import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";
import { buildTableBreakdown } from "../../src/core/table-view.js";
import type {
	ProcessedNode,
	ProcessedProfile,
} from "../../src/types/processed.js";

const FIXTURES = resolve(import.meta.dir, "../fixtures");

interface ParentSpec {
	functionName: string;
	objectType: string;
	objectId: number;
}

interface ChildSpec {
	functionName: string;
	objectType: string;
	objectId: number;
	objectName: string;
}

/**
 * Build a minimal synthetic ProcessedProfile from a list of (parent, child)
 * pairs — one root parent node plus one table-operation child beneath it per
 * pair. Children sharing the same objectName aggregate into one
 * TableBreakdown entry; entry.callSites (table-view.ts) tracks how many
 * distinct parent frames feed it. Mirrors the synthetic-profile pattern in
 * test/core/patterns.test.ts (makeIdentityNode / makeSiblingProfile).
 */
function makeProfileWithParents(
	pairs: { parent: ParentSpec; child: ChildSpec }[],
): ProcessedProfile {
	let nextId = 1;
	const allNodes: ProcessedNode[] = [];
	const roots: ProcessedNode[] = [];

	for (const { parent: parentSpec, child: childSpec } of pairs) {
		const parent: ProcessedNode = {
			id: nextId++,
			callFrame: {
				functionName: parentSpec.functionName,
				scriptId: `${parentSpec.objectType}_${parentSpec.objectId}`,
				url: "",
				lineNumber: 1,
				columnNumber: 0,
			},
			applicationDefinition: {
				objectType: parentSpec.objectType,
				objectName: `Test${parentSpec.objectType}`,
				objectId: parentSpec.objectId,
			},
			hitCount: 1,
			children: [],
			depth: 0,
			selfTime: 0,
			totalTime: 1,
			selfTimePercent: 0,
			totalTimePercent: 1,
		};

		const child: ProcessedNode = {
			id: nextId++,
			callFrame: {
				functionName: childSpec.functionName,
				scriptId: `${childSpec.objectType}_${childSpec.objectId}`,
				url: "",
				lineNumber: 1,
				columnNumber: 0,
			},
			applicationDefinition: {
				objectType: childSpec.objectType,
				objectName: childSpec.objectName,
				objectId: childSpec.objectId,
			},
			hitCount: 1,
			children: [],
			parent,
			depth: 1,
			selfTime: 1,
			totalTime: 1,
			selfTimePercent: 1,
			totalTimePercent: 1,
		};

		parent.children.push(child);
		roots.push(parent);
		allNodes.push(parent, child);
	}

	return {
		type: "sampling",
		roots,
		allNodes,
		nodeMap: new Map(allNodes.map((n) => [n.id, n])),
		totalDuration: allNodes.length,
		totalSelfTime: allNodes.reduce((sum, n) => sum + n.selfTime, 0),
		activeSelfTime: allNodes.reduce((sum, n) => sum + n.selfTime, 0),
		idleSelfTime: 0,
		maxDepth: 1,
		nodeCount: allNodes.length,
		startTime: 0,
		endTime: allNodes.length,
	};
}

describe("buildTableBreakdown", () => {
	test("returns empty array for profiles with no table operations", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const breakdown = buildTableBreakdown(processed);
		expect(Array.isArray(breakdown)).toBe(true);
		expect(breakdown.length).toBe(0);
	});

	test("aggregates table operations from instrumentation profile", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/instrumentation-minimal.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const breakdown = buildTableBreakdown(processed);
		expect(Array.isArray(breakdown)).toBe(true);
		// Results sorted by selfTime descending
		for (let i = 1; i < breakdown.length; i++) {
			expect(breakdown[i].totalSelfTime).toBeLessThanOrEqual(
				breakdown[i - 1].totalSelfTime,
			);
		}
	});

	test("groups operations by table name from TableData nodes", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/table-operations.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const breakdown = buildTableBreakdown(processed);

		// Should have two tables: Sales Line and Sales Header
		expect(breakdown.length).toBe(2);

		const salesLine = breakdown.find((t) => t.tableName === "Sales Line");
		const salesHeader = breakdown.find((t) => t.tableName === "Sales Header");
		expect(salesLine).toBeDefined();
		expect(salesHeader).toBeDefined();

		// Sales Line has Modify (300000) + FindSet (100000) + Insert (50000) = 450000
		expect(salesLine!.totalSelfTime).toBe(450000);

		// Sales Header has FindSet (200000) + CalcFields (150000) = 350000
		expect(salesHeader!.totalSelfTime).toBe(350000);
	});

	test("sorted by totalSelfTime descending", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/table-operations.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const breakdown = buildTableBreakdown(processed);

		// Sales Line (450000) should be first, then Sales Header (350000)
		expect(breakdown[0].tableName).toBe("Sales Line");
		expect(breakdown[1].tableName).toBe("Sales Header");
	});

	test("computes operation breakdown per table", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/table-operations.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const breakdown = buildTableBreakdown(processed);

		const salesLine = breakdown.find((t) => t.tableName === "Sales Line")!;
		expect(salesLine.operationBreakdown.length).toBe(3);

		// Operations sorted by selfTime descending
		expect(salesLine.operationBreakdown[0].operation).toBe("Modify");
		expect(salesLine.operationBreakdown[0].selfTime).toBe(300000);
		expect(salesLine.operationBreakdown[0].hitCount).toBe(10);

		expect(salesLine.operationBreakdown[1].operation).toBe("FindSet");
		expect(salesLine.operationBreakdown[1].selfTime).toBe(100000);
		expect(salesLine.operationBreakdown[1].hitCount).toBe(3);

		expect(salesLine.operationBreakdown[2].operation).toBe("Insert");
		expect(salesLine.operationBreakdown[2].selfTime).toBe(50000);
		expect(salesLine.operationBreakdown[2].hitCount).toBe(2);
	});

	test("counts distinct call sites", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/table-operations.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const breakdown = buildTableBreakdown(processed);

		// Sales Header has nodes 2 and 4 — node 2's parent is OnRun:50000, node 4's parent is ProcessLines:50000
		const salesHeader = breakdown.find((t) => t.tableName === "Sales Header")!;
		expect(salesHeader.callSiteCount).toBe(2);

		// Sales Line has nodes 3, 6, 7 — all parents are ProcessLines:50000
		const salesLine = breakdown.find((t) => t.tableName === "Sales Line")!;
		expect(salesLine.callSiteCount).toBe(1);
	});

	test("computes totalSelfTimePercent relative to activeSelfTime", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/table-operations.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const breakdown = buildTableBreakdown(processed);

		// activeSelfTime = sum of all selfTimes (no idle nodes):
		//   50000 + 200000 + 30000 + 300000 + 150000 + 100000 + 50000 = 880000
		// Sales Line: 450000 / 880000 * 100 ~ 51.14%
		const salesLine = breakdown.find((t) => t.tableName === "Sales Line")!;
		expect(salesLine.totalSelfTimePercent).toBeCloseTo(51.14, 0);

		// Sales Header: 350000 / 880000 * 100 ~ 39.77%
		const salesHeader = breakdown.find((t) => t.tableName === "Sales Header")!;
		expect(salesHeader.totalSelfTimePercent).toBeCloseTo(39.77, 0);
	});

	test("defaults source flags to false without source index", async () => {
		const parsed = await parseProfile(
			`${FIXTURES}/table-operations.alcpuprofile`,
		);
		const processed = processProfile(parsed);
		const breakdown = buildTableBreakdown(processed);

		for (const entry of breakdown) {
			expect(entry.hasSetLoadFields).toBe(false);
			expect(entry.hasFilters).toBe(false);
		}
	});
});

describe("callSiteCount — parents sharing an object id", () => {
	const CHILD: ChildSpec = {
		functionName: "FindSet",
		objectType: "TableData",
		objectId: 27,
		objectName: "Customer",
	};

	test("counts a Codeunit 50000 parent and a Table 50000 parent as two call sites", () => {
		// Same function name, same objectId, different objectType — legal in AL.
		// The old key `${functionName}:${objectId}` merged them into one site.
		const profile = makeProfileWithParents([
			{
				parent: {
					functionName: "Run",
					objectType: "Codeunit",
					objectId: 50000,
				},
				child: CHILD,
			},
			{
				parent: { functionName: "Run", objectType: "Table", objectId: 50000 },
				child: CHILD,
			},
		]);

		const breakdown = buildTableBreakdown(profile);
		const customer = breakdown.find((t) => t.tableName === "Customer");

		expect(customer?.callSiteCount).toBe(2);
	});

	test("two parents with identical function, type, and id still count as one call site", () => {
		// Same function name, same objectType, same objectId across two distinct
		// node instances — this is a genuine merge case and must stay at 1 so the
		// fix isn't just "make every parent distinct".
		const profile = makeProfileWithParents([
			{
				parent: {
					functionName: "Run",
					objectType: "Codeunit",
					objectId: 50000,
				},
				child: CHILD,
			},
			{
				parent: {
					functionName: "Run",
					objectType: "Codeunit",
					objectId: 50000,
				},
				child: CHILD,
			},
		]);

		const breakdown = buildTableBreakdown(profile);
		const customer = breakdown.find((t) => t.tableName === "Customer");

		expect(customer?.callSiteCount).toBe(1);
	});

	test("counts two Codeunit 50000/50001 parents with the same function name as two call sites", () => {
		// Same function name, same objectType, different objectId — legal in AL
		// (e.g., "Run" defined on two different codeunits). Dropping objectId
		// from the key would merge these into one call site.
		const profile = makeProfileWithParents([
			{
				parent: {
					functionName: "Run",
					objectType: "Codeunit",
					objectId: 50000,
				},
				child: CHILD,
			},
			{
				parent: {
					functionName: "Run",
					objectType: "Codeunit",
					objectId: 50001,
				},
				child: CHILD,
			},
		]);

		const breakdown = buildTableBreakdown(profile);
		const customer = breakdown.find((t) => t.tableName === "Customer");

		expect(customer?.callSiteCount).toBe(2);
	});
});
