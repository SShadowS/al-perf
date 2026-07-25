import { describe, expect, test } from "bun:test";
import { drilldownMethod } from "../../src/core/drilldown.js";

const FIXTURES = "test/fixtures";

describe("drilldownMethod", () => {
	test("returns subtree breakdown for a method", async () => {
		const result = await drilldownMethod(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			"OnRun",
		);
		expect(result).toBeDefined();
		expect(result!.method.functionName).toBe("OnRun");
		expect(result!.breakdown.childContributions.length).toBeGreaterThan(0);
		// OnRun calls ProcessLine — ProcessLine should be in child contributions
		const processLine = result!.breakdown.childContributions.find(
			(c) => c.functionName === "ProcessLine",
		);
		expect(processLine).toBeDefined();
		expect(processLine!.contributionPercent).toBeGreaterThan(0);
		// Self + children should roughly equal totalTime
		const childTotal = result!.breakdown.childContributions.reduce(
			(sum, c) => sum + c.totalTime,
			0,
		);
		expect(result!.breakdown.selfTimeInMethod + childTotal).toBeCloseTo(
			result!.method.totalTime,
			-2,
		);
	});

	test("returns null for non-existent method", async () => {
		const result = await drilldownMethod(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			"NonExistentMethod",
		);
		expect(result).toBeNull();
	});
});

describe("drilldownMethod — its two numbers must describe the same thing", () => {
	test("totalTime and totalTimePercent agree, and recursion is not double-counted", async () => {
		// The value was summed over every matching node while the percentage was
		// read off ONE node, so the two described different scopes. On a captured
		// profile drilldown_method reported PostItem at totalTime 254,702 with
		// 18.01% — a figure that is 36% of that profile. explain_method said
		// 36.03% for the same method. Both were wrong in different ways: the sum
		// double-counted the recursion, and the percentage belonged to a single
		// node.
		const result = (await drilldownMethod(
			`${FIXTURES}/recursive-profile.alcpuprofile`,
			"ProcessRecursive",
		))!;
		expect(result).toBeDefined();

		const { parseProfile } = await import("../../src/core/parser.js");
		const { processProfile } = await import("../../src/core/processor.js");
		const profile = processProfile(
			await parseProfile(`${FIXTURES}/recursive-profile.alcpuprofile`),
		);

		// Outermost occurrence only: the inner calls' time is already inside it.
		const outermost = profile.allNodes.filter(
			(n) =>
				n.callFrame.functionName === "ProcessRecursive" &&
				n.parent?.callFrame.functionName !== "ProcessRecursive",
		);
		const truth = outermost.reduce((s, n) => s + n.totalTime, 0);
		expect(result.method.totalTime).toBe(truth);

		// And the percentage is that same number's share, not another node's.
		const expectedPct = (truth / profile.activeSelfTime) * 100;
		expect(result.method.totalTimePercent).toBeCloseTo(expectedPct, 6);
	});
});
