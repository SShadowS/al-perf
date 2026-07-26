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

	test("does not flag an inner loop that performs no record operation", async () => {
		// A `for i := 1 to KRef.FieldCount` walking key fields through FieldRef
		// is bounded by the key width and never touches the database. It
		// multiplies CPU, not round-trips.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectNestedLoops(index);
		const falsePositive = patterns.find((p) =>
			p.involvedMethods.some((m) =>
				m.includes("LoopOverKeyFieldsInsideRecordLoop"),
			),
		);
		expect(falsePositive).toBeUndefined();
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

	test("downgrades a find on a record PARAMETER — the caller may have filtered it", async () => {
		// Filters travel with a record variable in AL, by value as well as by
		// reference, so `procedure P(SalesLine: Record "Sales Line")` doing
		// `SalesLine.FindSet()` may be reading a filtered set the member cannot
		// see. 978 of 5,432 candidates on a 15,436-file corpus are this shape.
		// Still reported — the caller may equally have filtered nothing — but
		// not as a stated full table scan.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnfilteredFindSet(index);
		for (const name of ["FindOnValueParameter", "FindOnVarParameter"]) {
			const p = patterns.find((x) =>
				x.involvedMethods.some((m) => m.includes(name)),
			);
			expect(p).toBeDefined();
			expect(p!.severity).toBe("info");
			expect(p!.description).toMatch(/caller|parameter/i);
		}
	});

	test("downgrades a find on an object's implicit Rec", async () => {
		// A Page/Table `Rec` arrives filtered by SourceTableView, by the
		// caller's SetTableView, and by the user's filter pane — none of it
		// visible in the member. 253 candidates on a 15,436-file corpus are an
		// implicit Rec, 173 of them on Pages.
		const index = await buildSourceIndex("test/fixtures/source");
		const p = detectUnfilteredFindSet(index).find((x) =>
			x.involvedMethods.some((m) => m.includes("PositionOnFirstEntry")),
		);
		expect(p).toBeDefined();
		expect(p!.severity).toBe("info");
		expect(p!.description).toMatch(/SourceTableView|caller|filter pane/i);
	});

	test("keeps warning for a find on a LOCAL record", async () => {
		// A local is declared right here with no filters, so the full-table
		// claim is one this detector can actually support.
		const index = await buildSourceIndex("test/fixtures/source");
		const p = detectUnfilteredFindSet(index).find((x) =>
			x.involvedMethods.some((m) => m.includes("UnfilteredQuery")),
		);
		expect(p!.severity).toBe("warning");
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

	test("does not flag FindSet with preceding SetView", async () => {
		// SetView applies a filter group the same way SetRange does — it is how
		// a caller-supplied filter string reaches the record.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnfilteredFindSet(index);
		const falsePositive = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("FilteredBySetView")),
		);
		expect(falsePositive).toBeUndefined();
	});

	test("does not flag a FindSet preceded by CopyFilters on the receiver", async () => {
		// Plural CopyFilters copies every filter onto the receiver, so Target is
		// filtered with no SetRange/SetFilter anywhere in the member.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnfilteredFindSet(index);
		const falsePositive = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("CopyFiltersFromCaller")),
		);
		expect(falsePositive).toBeUndefined();
	});

	test("does not flag a FindSet whose filter arrived via singular CopyFilter", async () => {
		// COPYFILTER("No.", Other."No.") filters Other -- the record owning the
		// SECOND argument -- not the implicit Rec it is called on.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnfilteredFindSet(index);
		const falsePositive = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("CopyFilterAcrossRecords")),
		);
		expect(falsePositive).toBeUndefined();
	});

	test("does not flag a RecordRef find — its filters live on FieldRef", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnfilteredFindSet(index);
		const falsePositive = patterns.find((p) =>
			p.involvedMethods.some((m) =>
				m.includes("RecordRefFindIsNotAnUnfilteredFindSet"),
			),
		);
		expect(falsePositive).toBeUndefined();
	});

	test("still flags a FindSet preceded only by SetCurrentKey", async () => {
		// SetCurrentKey picks the sort order and restricts nothing, so the read
		// is still the whole table.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnfilteredFindSet(index).filter((p) =>
			p.involvedMethods.some((m) => m.includes("SetCurrentKeyIsNotAFilter")),
		);
		expect(patterns).toHaveLength(1);
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
		// Covers both halves of external-call-in-loop (HttpClient calls AND
		// bare Sleep()) -- adding "sleep" to DANGEROUS_CALLS instead of
		// keeping it a distinct pattern id would double-report the same call
		// under both ids without either of these assertions catching it.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectDangerousCallsInLoop(index);
		expect(
			patterns.find((p) =>
				p.involvedMethods.some((m) => m.includes("HttpSendInLoop")),
			),
		).toBeUndefined();
		expect(
			patterns.find((p) =>
				p.involvedMethods.some((m) => m.includes("SleepInLoop")),
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

	test("rates a Sleep in a retry-backoff loop as info, not critical", async () => {
		// `repeat ... until Success or (RetryCount >= MaxRetries)` terminates on
		// a predicate, not on running out of rows. The delay is deliberate.
		const index = await buildSourceIndex("test/fixtures/source");
		const f = detectExternalCallInLoop(index).find((p) =>
			p.involvedMethods.some((m) => m.includes("SleepInRetryBackoff")),
		);
		expect(f).toBeDefined();
		expect(f!.severity).toBe("info");
		expect(f!.suggestion).not.toMatch(/remove sleep/i);
	});

	test("rates a Sleep in a while-condition throttle as info", async () => {
		const index = await buildSourceIndex("test/fixtures/source");
		const f = detectExternalCallInLoop(index).find((p) =>
			p.involvedMethods.some((m) => m.includes("SleepInThrottleLoop")),
		);
		expect(f).toBeDefined();
		expect(f!.severity).toBe("info");
	});

	test("keeps critical for a Sleep in a data-driven loop", async () => {
		// `for i := 1 to 10` is bounded by data, not by a condition the body is
		// waiting on — the delay really does multiply by the iteration count.
		const index = await buildSourceIndex("test/fixtures/source");
		const f = detectExternalCallInLoop(index).find((p) =>
			p.involvedMethods.some((m) => m.includes("SleepInLoop")),
		);
		expect(f).toBeDefined();
		expect(f!.severity).toBe("critical");
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

	test("flags a bare Sleep() in a report OnAfterGetRecord — implicit loop", async () => {
		// Same implicit-loop shape as the HttpClient.Send() test above
		// (SlowReport.al, report 50800) but for the bare-Sleep() branch of
		// the detector, which previously had no direct test even though it
		// was reachable and correct.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectExternalCallInLoop(index);
		const f = patterns.find(
			(p) =>
				p.title.includes("Sleep") &&
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

	test("flags an object-level global HttpClient in a loop", () => {
		// This was a KNOWN LIMITATION, pinned by a negative test: extractVariables
		// read only a member's own var_section, so an HttpClient declared as an
		// object-level global and reused across procedures -- normal BC code --
		// never resolved, and unlike the record detectors (where a globals gap
		// only degraded a temp/table refinement) the declared-type gate IS this
		// detector, so it failed closed and the call was invisible.
		//
		// Object-level globals are now indexed, so the call is detected. The old
		// test demanded `toBeUndefined()` and failed loudly when the behavior
		// changed underneath it, exactly as it was written to.
		return buildSourceIndex("test/fixtures/source").then((index) => {
			const f = detectExternalCallInLoop(index).find((p) =>
				p.involvedMethods.some((m) =>
					m.includes("ObjectLevelGlobalHttpClientInLoop"),
				),
			);
			expect(f).toBeDefined();
			expect(f!.id).toBe("external-call-in-loop");
			expect(f!.title).toContain("HttpClient.Send()");
		});
	});

	test("does not match Object.prototype keys via the 'in' operator (prototype-chain false positive)", async () => {
		// EXTERNAL_HTTP_CALL_CASE_MAP is a plain object literal. `methodName in
		// EXTERNAL_HTTP_CALL_CASE_MAP` matches inherited Object.prototype keys
		// too -- "constructor" resolves through the prototype chain to the
		// Object constructor function itself (not undefined), so a
		// non-compiling `Client.Constructor()` used to produce a garbage
		// finding whose `type` was a function, not a string. Fixed with
		// Object.hasOwn(...).
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectExternalCallInLoop(index);
		expect(
			patterns.find((p) =>
				p.involvedMethods.some((m) =>
					m.includes("HttpClientPrototypeChainInLoop"),
				),
			),
		).toBeUndefined();
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

	test("does not flag a residual filter when a sibling filter covers a key's leading field", async () => {
		// FilterWithCoveringSibling filters "Customer No." (leading field of key
		// CustomerDate) and Description (leading field of nothing) on the same
		// record. SQL seeks CustomerDate and applies Description as a residual
		// predicate — there is no scan, so flagging Description is a false positive.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnindexedFilters(index);
		const residual = patterns.find((p) =>
			p.involvedMethods.some((m) => m.includes("FilterWithCoveringSibling")),
		);
		expect(residual).toBeUndefined();
	});

	test("still flags when the covering filter is on a different record variable", async () => {
		// A filter on OtherKeyTest cannot give KeyTest a seekable access path,
		// so suppression must be scoped to the same record variable.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = detectUnindexedFilters(index).filter((p) =>
			p.involvedMethods.some((m) =>
				m.includes("FilterWithSiblingOnOtherRecord"),
			),
		);
		expect(patterns).toHaveLength(1);
		expect(patterns[0].title).toContain("Description");
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

	test("ranks findings by severity when impact ties at zero", async () => {
		// Every source-only detector emits impact 0 (there is no profile, so
		// there is no measured time) — this is the exact scenario the
		// prioritization fix targets. A theoretical finding used to rank
		// identically to a real one just because the array happened to put it
		// first.
		const index = await buildSourceIndex("test/fixtures/source");
		const patterns = runSourceOnlyDetectors(index);
		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns.every((p) => p.impact === 0)).toBe(true);

		const rank: Record<string, number> = { critical: 3, warning: 2, info: 1 };
		for (let i = 1; i < patterns.length; i++) {
			expect(rank[patterns[i].severity]).toBeLessThanOrEqual(
				rank[patterns[i - 1].severity],
			);
		}

		// Guard against a vacuous pass: the fixture must genuinely produce more
		// than one severity level, otherwise the assertion above proves nothing.
		const severities = new Set(patterns.map((p) => p.severity));
		expect(severities.size).toBeGreaterThan(1);
	});
});

describe("unindexed-filter on a record parameter", () => {
	test("resolves a parameter's table so the filter can be judged at all", async () => {
		// detectUnindexedFilters needs variable.isRecord + tableName. With
		// parameters unindexed, every filter on a parameter record was skipped
		// silently — a recall hole, not a precision one.
		const index = await buildSourceIndex("test/fixtures/source");
		const f = detectUnindexedFilters(index).find((p) =>
			p.involvedMethods.some((m) => m.includes("FilterParameterRecord")),
		);
		expect(f).toBeDefined();
		expect(f!.title).toContain("Description");
		expect(f!.title).toContain("Key Test Table");
	});
});

describe("unindexed-filter — fields that cannot cause a scan", () => {
	test("a FlowFilter and SystemId are never unindexed filters", async () => {
		// A FlowFilter is not a table column: it parameterises FlowField
		// calculation and has no index by definition. SystemId carries its own
		// unique index in BC. Neither can produce the scan this detector warns
		// about. On a 15,436-file corpus "Date Filter" was the single
		// most-flagged field (450) and SystemId accounted for another 147.
		const index = await buildSourceIndex("test/fixtures/source");
		const found = detectUnindexedFilters(index).filter((p) =>
			p.involvedMethods.some((m) =>
				m.includes("FilterOnFlowFilterAndSystemId"),
			),
		);
		expect(found).toHaveLength(0);
	});
});

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

	test("skips a table whose name is ambiguous", async () => {
		// Two roots share the name "Merge Ambig"; the winning root's fields
		// and keys survive the merge and would otherwise raise a finding
		// (AlphaOnly leads no key on the surviving root), but neither answer
		// is about the table actually in hand.
		expect(await findings("FiltersOnAmbiguousTable")).toHaveLength(0);
	});
});
