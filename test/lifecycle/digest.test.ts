/**
 * digest.test.ts — digest sections, since-filtering, totals, and the
 * markdown rendering. Findings are seeded directly through the store.
 */

import { describe, expect, it } from "bun:test";
import {
	buildDigest,
	renderDigestMarkdown,
} from "../../src/lifecycle/digest.js";
import {
	computeTelemetryFingerprint,
	formatFingerprint,
} from "../../src/lifecycle/fingerprint.js";
import type { FindingState } from "../../src/lifecycle/states.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";

let seq = 0;
function seed(
	store: LifecycleStore,
	state: FindingState,
	overrides?: Partial<NewFinding>,
): number {
	seq++;
	return store.insertFinding({
		tenant: "t1",
		fingerprint: `pattern:fp${String(seq).padStart(12, "0")}`,
		algoVersion: 1,
		state,
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: `Finding ${seq}`,
		severity: "warning",
		appId: "",
		appName: "My App",
		routineKey: "",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-05T00:00:00Z",
		lastEventAt: "2026-07-05T00:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["nightly"],
		...overrides,
	});
}

describe("buildDigest", () => {
	it("sections findings by state and counts totals + needs-triage", () => {
		const store = new LifecycleStore(":memory:");
		seed(store, "new");
		seed(store, "open");
		seed(store, "regressed");
		seed(store, "improving");
		const resolvedId = seed(store, "resolved");
		store.db.run(
			"UPDATE findings SET resolved_at = '2026-07-05T00:00:00Z' WHERE id = ?",
			[resolvedId],
		);
		const triageId = seed(store, "open", { needsTriage: true });
		const digest = buildDigest(store, {
			tenant: "t1",
			now: "2026-07-09T00:00:00Z",
		});
		expect(digest.totals).toEqual({
			new: 1,
			open: 2,
			regressed: 1,
			improving: 1,
			resolved: 1,
			closed: 0,
			needsTriage: 1,
		});
		expect(digest.newFindings).toHaveLength(1);
		expect(digest.regressed).toHaveLength(1);
		expect(digest.improving).toHaveLength(1);
		expect(digest.resolved).toHaveLength(1);
		expect(digest.needsTriage[0]?.fingerprint).toBe(
			store.getFinding(triageId)?.fingerprint,
		);
		store.close();
	});

	it("locks the DigestFindingEntry contract shape (all 11 fields)", () => {
		const store = new LifecycleStore(":memory:");
		seed(store, "new", {
			fingerprint: "pattern:fpcontract0001",
			title: "Contract check",
			severity: "info",
			appName: "Contract App",
			patternId: "modify-in-loop",
			firstSeenAt: "2026-07-02T00:00:00Z",
			lastSeenAt: "2026-07-03T00:00:00Z",
		});
		const digest = buildDigest(store, { tenant: "t1" });
		expect(digest.newFindings[0]).toEqual({
			fingerprint: "pattern:fpcontract0001",
			title: "Contract check",
			severity: "info",
			state: "new",
			needsTriage: false,
			appName: "Contract App",
			patternId: "modify-in-loop",
			firstSeenAt: "2026-07-02T00:00:00Z",
			lastSeenAt: "2026-07-03T00:00:00Z",
			occurrenceCount: 0,
			lastEvent: null,
		});
		store.close();
	});

	it("since filters sections by their relevant timestamp", () => {
		const store = new LifecycleStore(":memory:");
		seed(store, "new", { firstSeenAt: "2026-06-01T00:00:00Z" }); // old — excluded
		seed(store, "new", { firstSeenAt: "2026-07-08T00:00:00Z" });
		const resolvedOld = seed(store, "resolved");
		store.db.run(
			"UPDATE findings SET resolved_at = '2026-06-01T00:00:00Z' WHERE id = ?",
			[resolvedOld],
		);
		const digest = buildDigest(store, {
			tenant: "t1",
			since: "2026-07-01T00:00:00Z",
		});
		expect(digest.newFindings).toHaveLength(1);
		expect(digest.resolved).toHaveLength(0);
		// Totals stay unfiltered (current inventory, not deltas).
		expect(digest.totals.new).toBe(2);
		store.close();
	});
});

describe("telemetry findings in the digest", () => {
	// digest.ts is source-agnostic (toEntry never reads row.source) — a
	// telemetry finding must render correctly through the EXISTING sectioning
	// and markdown rendering with zero digest.ts changes (YAGNI gate,
	// telemetry-ingest plan Task 6 step 1). This test is the deliverable.
	it("renders a telemetry finding with its telemetry: fingerprint and RT-prefixed title, and leaves the 11-field digest contract untouched", () => {
		const store = new LifecycleStore(":memory:");
		const fingerprint = formatFingerprint(
			computeTelemetryFingerprint({
				signalId: "RT0018",
				appId: "11111111-2222-3333-4444-555555555555",
				objectType: "Codeunit",
				objectNumber: 50100,
				routineName: "PostSalesLine",
			}),
		);
		seed(store, "new", {
			fingerprint,
			source: "telemetry",
			patternId: "telemetry-rt0018",
			title: "RT0018: PostSalesLine (Codeunit 50100) slow — max 15000ms × 3",
			severity: "warning",
			appName: "My App",
		});

		const digest = buildDigest(store, { tenant: "t1" });
		const entry = digest.newFindings[0];
		expect(entry.fingerprint).toBe(fingerprint);
		expect(entry.fingerprint).toMatch(/^telemetry:[0-9a-f]{16}$/);
		expect(entry.title).toMatch(/^RT0018:/);
		// The 11-field JSON contract (digest.test.ts "locks the
		// DigestFindingEntry contract shape" above) is unchanged for a
		// telemetry-sourced entry — same shape as pattern/alsem entries.
		expect(Object.keys(entry).sort()).toEqual(
			[
				"fingerprint",
				"title",
				"severity",
				"state",
				"needsTriage",
				"appName",
				"patternId",
				"firstSeenAt",
				"lastSeenAt",
				"occurrenceCount",
				"lastEvent",
			].sort(),
		);

		const md = renderDigestMarkdown(digest);
		expect(md).toContain(fingerprint);
		expect(md).toContain("RT0018: PostSalesLine");
		store.close();
	});
});

describe("renderDigestMarkdown", () => {
	it("renders headers, counts, and finding lines", () => {
		const store = new LifecycleStore(":memory:");
		seed(store, "regressed", {
			title: "CalcFields storm",
			severity: "critical",
		});
		const md = renderDigestMarkdown(buildDigest(store, { tenant: "t1" }));
		expect(md).toContain("# al-perf Finding Digest");
		expect(md).toContain("## Regressed");
		expect(md).toContain("CalcFields storm");
		expect(md).toContain("critical");
		expect(md).toContain("pattern:fp"); // fingerprint shown for gh-recipe dedup
		store.close();
	});

	it("escapes @-mentions and markdown-breaking characters in finding text", () => {
		const store = new LifecycleStore(":memory:");
		seed(store, "regressed", {
			title: "](x)|@user",
			appName: "@other|app",
			patternId: "pattern]with|pipe@at",
		});
		const md = renderDigestMarkdown(buildDigest(store, { tenant: "t1" }));
		// The raw, unescaped injection must not appear anywhere in the output —
		// this markdown is the documented gh-recipe input (docs/lifecycle-gh-recipe.md)
		// and an unescaped @mention would ping a real GitHub user.
		expect(md).not.toContain("](x)|@user");
		expect(md).not.toContain("@other|app");
		expect(md).not.toContain("pattern]with|pipe@at");
		expect(md).toContain("\\](x)\\|\\@user");
		expect(md).toContain("\\@other\\|app");
		expect(md).toContain("pattern\\]with\\|pipe\\@at");
		store.close();
	});
});
