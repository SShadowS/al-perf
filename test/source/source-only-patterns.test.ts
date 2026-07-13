import { describe, expect, test } from "bun:test";
import { buildSourceIndex } from "../../src/source/indexer.js";
import {
	detectDangerousCallsInLoop,
	detectEventSubscriberIssues,
	detectExternalCallInLoop,
	detectNestedLoops,
	detectUnfilteredFindSet,
	detectUnindexedFilters,
	runSourceOnlyDetectors,
} from "../../src/source/source-only-patterns.js";

describe("detectNestedLoops", () => {
	test("detects nested loops in ProcessNestedLoops", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectNestedLoops(index);

		const nested = patterns.filter((p) => p.id === "nested-loops");
		expect(nested.length).toBeGreaterThanOrEqual(1);

		const match = nested.find((p) =>
			p.involvedMethods.some((m) => m.includes("ProcessNestedLoops")),
		);
		expect(match).toBeDefined();
		expect(match!.severity).toBe("warning");
		expect(match!.suggestion).toBeDefined();
	});

	test("does not flag single-level loops", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectNestedLoops(index);

		const falsePositive = patterns.find((p) =>
			p.involvedMethods.some(
				(m) => m.includes("ProcessRecords") && m.includes("50100"),
			),
		);
		expect(falsePositive).toBeUndefined();
	});
});

describe("detectUnfilteredFindSet", () => {
	test("detects FindSet without SetRange/SetFilter", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnfilteredFindSet(index);

		// CodeUnit50200 UnfilteredQuery has Customer.FindSet() without SetRange/SetFilter
		const match = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("UnfilteredQuery")),
		);
		expect(match).toBeDefined();
		expect(match!.id).toBe("unfiltered-findset");
		expect(match!.severity).toBe("warning");
		expect(match!.suggestion).toBeDefined();
	});

	test("does not flag FindSet with preceding SetRange", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnfilteredFindSet(index);

		// CodeUnit50200 FilteredQuery has SetRange before FindSet — should NOT appear
		const falsePositive = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("FilteredQuery")),
		);
		expect(falsePositive).toBeUndefined();
	});

	test("does not flag FindSet with preceding SetFilter", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnfilteredFindSet(index);

		// CodeUnit50100 ProcessRecords has SetRange before FindSet — should NOT appear
		const falsePositive = patterns.find((p) =>
			p.involvedMethods.some(
				(m) => m.includes("ProcessRecords") && m.includes("50100"),
			),
		);
		expect(falsePositive).toBeUndefined();
	});
});

describe("detectEventSubscriberIssues", () => {
	test("detects event subscriber with loops", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectEventSubscriberIssues(index);

		const match = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("OnBeforePostSalesDoc")),
		);
		expect(match).toBeDefined();
		expect(match!.suggestion).toBeDefined();
	});

	test("detects event subscriber with record ops in loops as warning", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectEventSubscriberIssues(index);

		const match = patterns.find(
			(p) => p.id === "event-subscriber-with-loop-ops",
		);
		expect(match).toBeDefined();
		expect(match!.severity).toBe("warning");
	});

	test("does not flag non-subscriber procedures", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectEventSubscriberIssues(index);

		const falsePositive = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("ProcessRecords")),
		);
		expect(falsePositive).toBeUndefined();
	});
});

describe("detectDangerousCallsInLoop", () => {
	test("detects Commit inside loop", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectDangerousCallsInLoop(index);
		const commitInLoop = patterns.find(
			(p) =>
				p.id === "dangerous-call-in-loop" &&
				p.title.includes("Commit") &&
				p.title.includes("CommitInLoop"),
		);
		expect(commitInLoop).toBeDefined();
		expect(commitInLoop!.severity).toBe("critical");
	});

	test("detects Error inside loop", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectDangerousCallsInLoop(index);
		const errorInLoop = patterns.find(
			(p) =>
				p.id === "dangerous-call-in-loop" &&
				p.title.includes("Error") &&
				p.title.includes("ErrorInLoop"),
		);
		expect(errorInLoop).toBeDefined();
	});

	test("does not flag Commit outside loop", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectDangerousCallsInLoop(index);
		const safeCommit = patterns.find((p) => p.title.includes("SafeCommit"));
		expect(safeCommit).toBeUndefined();
	});
});

describe("dangerous-call-in-loop implicit loops (Part B)", () => {
	test("flags Commit in a report OnAfterGetRecord — commit-per-row", async () => {
		// A Commit() in a report's OnAfterGetRecord is commit-per-row — one of
		// the worst BC performance bugs there is. There is no repeat/for/
		// foreach/while anywhere in the source (SlowReport.al, report 50800):
		// the platform itself is the loop. Before Part B, dangerousCallsInLoops
		// was built from syntactic loops only, so this was completely invisible.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectDangerousCallsInLoop(index);
		const found = patterns.find(
			(p) =>
				p.id === "dangerous-call-in-loop" &&
				p.title.includes("Commit") &&
				p.involvedMethods.some((m) => m.includes("50800")),
		);
		expect(found).toBeDefined();
		expect(found!.severity).toBe("critical");
		expect(found!.evidence).toContain("Report.OnAfterGetRecord");
		expect(found!.evidence).toContain("runs once per row");
		expect(found!.description).toContain("Report.OnAfterGetRecord");
	});

	test("flags Commit in a Page OnAfterGetRecord at reduced (warning) severity", async () => {
		// A page renders tens of rows, not a report's millions — same
		// implicit-loop shape, dropped one severity level, same as the
		// record-op detectors' Page downgrade.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectDangerousCallsInLoop(index);
		const found = patterns.find(
			(p) =>
				p.id === "dangerous-call-in-loop" &&
				p.title.includes("Commit") &&
				p.involvedMethods.some((m) => m.includes("50803")),
		);
		expect(found).toBeDefined();
		expect(found!.severity).toBe("warning");
		expect(found!.evidence).toContain("Page.OnAfterGetRecord");
	});
});

describe("external-call-in-loop", () => {
	test("flags HttpClient.Send() inside a loop", async () => {
		// One network round-trip per iteration.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectExternalCallInLoop(index);
		const f = patterns.find(
			(p) =>
				p.id === "external-call-in-loop" &&
				p.involvedMethods.some((m) => m.includes("HttpSendInLoop")),
		);
		expect(f).toBeDefined();
		expect(f?.severity).toBe("critical");
		expect(f?.suggestion).toMatch(/batch|outside the loop|single request/i);
	});

	test("does not flag an HttpClient.Send() outside a loop", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectExternalCallInLoop(index);
		expect(
			patterns.find((p) =>
				p.involvedMethods.some((m) => m.includes("HttpSendNoLoop")),
			),
		).toBeUndefined();
	});

	test("leaves dangerous-call-in-loop reporting only Commit/Error/TestField", async () => {
		// Transactional problems, different fix, separate id. Not merged.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectDangerousCallsInLoop(index);
		expect(
			patterns.find((p) =>
				p.involvedMethods.some((m) => m.includes("HttpSendInLoop")),
			),
		).toBeUndefined();
	});

	test("does not conflate a record Get() with an HttpClient Get() in the same loop", async () => {
		// Get()/Delete() collide with record-op method names by name alone —
		// only the HttpClient-typed variable's Get() may become an
		// external-call-in-loop finding here.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectExternalCallInLoop(index).filter((p) =>
			p.involvedMethods.some((m) => m.includes("HttpGetVsRecordGetInLoop")),
		);
		expect(patterns).toHaveLength(1);
		expect(patterns[0].id).toBe("external-call-in-loop");
	});

	test("flags Post/Put/Patch/Delete on an HttpClient, not just Send/Get", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectExternalCallInLoop(index).filter((p) =>
			p.involvedMethods.some((m) => m.includes("HttpMethodsInLoop")),
		);
		expect(patterns).toHaveLength(4);
	});

	test("flags a bare Sleep() inside a loop", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectExternalCallInLoop(index);
		const f = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("SleepInLoop")),
		);
		expect(f).toBeDefined();
		expect(f?.severity).toBe("critical");
	});

	test("flags HttpClient.Send() in a report OnAfterGetRecord — implicit loop", async () => {
		// Same implicit-loop shape as the record-op / dangerous-call detectors:
		// SlowReport.al's OnAfterGetRecord has no repeat/for/foreach/while.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectExternalCallInLoop(index);
		const f = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("50800")),
		);
		expect(f).toBeDefined();
		expect(f!.severity).toBe("critical");
		expect(f!.evidence).toContain("Report.OnAfterGetRecord");
		expect(f!.evidence).toContain("runs once per row");
		expect(f!.description).toContain("Report.OnAfterGetRecord");
	});

	test("flags HttpClient.Send() in a Page OnAfterGetRecord at reduced (warning) severity", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectExternalCallInLoop(index);
		const f = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("50803")),
		);
		expect(f).toBeDefined();
		expect(f!.severity).toBe("warning");
		expect(f!.evidence).toContain("Page.OnAfterGetRecord");
	});

	test("is wired into runSourceOnlyDetectors", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = runSourceOnlyDetectors(index);
		expect(
			patterns.find((p) => p.id === "external-call-in-loop"),
		).toBeDefined();
	});
});

describe("detectUnindexedFilters", () => {
	test("flags SetRange on field with no supporting key", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnindexedFilters(index);
		// FilterWithoutIndex does SetRange(Description, ...) on Key Test Table
		// Key Test Table has keys: PK(No.), CustomerDate(Customer No., Posting Date), AmountIdx(Amount)
		// Description is not the first field of any key => should be flagged
		const descriptionFilter = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("FilterWithoutIndex")),
		);
		expect(descriptionFilter).toBeDefined();
		expect(descriptionFilter!.id).toBe("unindexed-filter");
		expect(descriptionFilter!.severity).toBe("warning");
	});

	test("does not flag SetRange on field covered by a key", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnindexedFilters(index);
		// FilterWithIndex does SetRange("No.", ...) — covered by PK
		// FilterOnSecondaryKey does SetRange("Customer No.", ...) — covered by CustomerDate key
		const indexedFilter = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("FilterWithIndex")),
		);
		expect(indexedFilter).toBeUndefined();

		const secondaryFilter = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("FilterOnSecondaryKey")),
		);
		expect(secondaryFilter).toBeUndefined();
	});
});

describe("runSourceOnlyDetectors", () => {
	test("returns patterns sorted by impact descending", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = runSourceOnlyDetectors(index);
		expect(patterns.length).toBeGreaterThan(0);

		for (let i = 1; i < patterns.length; i++) {
			expect(patterns[i].impact).toBeLessThanOrEqual(patterns[i - 1].impact);
		}
	});
});
