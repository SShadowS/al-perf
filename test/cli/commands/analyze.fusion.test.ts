import { describe, expect, test } from "bun:test";
import { analyzeProfile } from "../../../src/core/analyzer.js";

const FIXTURES = "test/fixtures";

describe("analyze fusion wiring", () => {
	test("fusionViews is undefined when fusion does not run (no workspace)", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		expect(result.fusionViews).toBeUndefined();
	});

	test("onAllMethods receives the full non-idle method set untruncated by top:1", async () => {
		let allMethodsCount = -1;
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
			{
				top: 1,
				onAllMethods: (m) => {
					allMethodsCount = m.length;
				},
			},
		);
		// The fixture has 2 non-idle methods; top:1 truncates hotspots but not allMethods
		expect(result.hotspots.length).toBe(1);
		expect(allMethodsCount).toBeGreaterThanOrEqual(result.hotspots.length);
		// Confirm untruncated: callback received more than top:1 allows
		expect(allMethodsCount).toBe(2);
	});

	test("onAllMethods receives non-idle methods (no IdleTime frames)", async () => {
		let receivedMethods: string[] = [];
		await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`, {
			onAllMethods: (m) => {
				receivedMethods = m.map((x) => x.functionName);
			},
		});
		expect(receivedMethods.every((name) => name !== "IdleTime")).toBe(true);
	});

	test("result is byte-unchanged when fusionViews is absent (R2-1 contract)", async () => {
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		// No fusionViews key at all — JSON.stringify must not include it
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("fusionViews");
		// Core fields present
		expect(result.hotspots).toBeDefined();
		expect(result.meta).toBeDefined();
		expect(result.summary).toBeDefined();
	});
});
