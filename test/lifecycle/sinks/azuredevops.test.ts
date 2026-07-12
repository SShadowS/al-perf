/**
 * azuredevops.test.ts — mocked-HTTP contract tests (paths, methods, headers,
 * bodies, retryability classification) and injection-escaping tests for the
 * Azure DevOps Work Items sink.
 */

import { describe, expect, it } from "bun:test";
import {
	createAzureDevOpsSink,
	escapeHtml,
	renderDescription,
	renderTitle,
} from "../../../src/lifecycle/sinks/azuredevops.js";
import type {
	SinkDelivery,
	SinkFindingContext,
	SinkIssueMapPort,
} from "../../../src/lifecycle/sinks/types.js";

function ctx(overrides?: Partial<SinkFindingContext>): SinkFindingContext {
	return {
		fingerprint: "pattern:abc123def4567890",
		title: "CalcFields inside loop",
		severity: "critical",
		state: "open",
		patternId: "calcfields-in-loop",
		appName: "My App",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-08T00:00:00Z",
		occurrenceCount: 4,
		event: "seen-normal",
		metricClass: null,
		resolvedAt: null,
		evidence: null,
		...overrides,
	};
}

function delivery(kind: SinkDelivery["kind"], finding = ctx()): SinkDelivery {
	return {
		id: 1,
		tenant: "t1",
		sink: "azureDevOps",
		kind,
		findingId: 1,
		payload: { finding, labels: ["al-perf"] },
		dedupeKey: `k-${kind}`,
	};
}

function memoryIssueMap(): SinkIssueMapPort & { entries: Map<string, string> } {
	const entries = new Map<string, string>();
	return {
		entries,
		getIssueMapping(tenant, sink, fingerprint) {
			const externalId = entries.get(`${tenant}:${sink}:${fingerprint}`);
			return externalId
				? { tenant, sink, fingerprint, externalId, externalUrl: null }
				: null;
		},
		putIssueMapping(m) {
			entries.set(`${m.tenant}:${m.sink}:${m.fingerprint}`, m.externalId);
		},
	};
}

function mockFetch(
	status: number,
	json: unknown,
	headers?: Record<string, string>,
) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const impl = (async (url: unknown, init?: unknown) => {
		calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
		return new Response(JSON.stringify(json), { status, headers });
	}) as typeof fetch;
	return { impl, calls };
}

function sink(
	overrides?: Partial<Parameters<typeof createAzureDevOpsSink>[0]>,
) {
	return createAzureDevOpsSink({
		org: "myorg",
		project: "myproj",
		workItemType: "Bug",
		tags: ["al-perf"],
		closedState: "Closed",
		reopenState: "Active",
		token: "s3cr3t-pat",
		...overrides,
	});
}

describe("escaping (injection tests)", () => {
	it('escapeHtml neutralizes & < > "', () => {
		const out = escapeHtml(`<script>alert("hi")</script> & </div> @mention`);
		expect(out).not.toContain("<script>");
		expect(out).not.toContain("</div>");
		expect(out).not.toContain('"hi"');
		expect(out).toContain("&lt;script&gt;");
		expect(out).toContain("&lt;/div&gt;");
		expect(out).toContain("&amp;");
		expect(out).toContain("&quot;hi&quot;");
		// @mention has no special meaning in HTML — it survives verbatim, which
		// is fine: ADO doesn't interpret @ as a live mention trigger the way
		// GitHub markdown does, and the surrounding tags are what matter.
		expect(out).toContain("@mention");
	});

	it("escapeHtml escapes & before producing entities that could be double-escaped", () => {
		const out = escapeHtml('<>&"');
		expect(out).toBe("&lt;&gt;&amp;&quot;");
	});

	it("renderTitle and renderDescription carry no raw tag from finding text", () => {
		const hostile = ctx({
			title: "<script>alert(1)</script>",
			evidence: "</div><img src=x onerror=alert(1)>",
			appName: '"><svg onload=alert(1)>',
		});
		const title = renderTitle(hostile);
		expect(title).not.toContain("<script>");
		expect(title).not.toContain("</script>");
		expect(title).toContain("&lt;script&gt;");

		const body = renderDescription(hostile);
		expect(body).not.toContain("</div><img");
		expect(body).not.toContain("<svg onload=alert(1)>");
		expect(body).toContain("&lt;/div&gt;");
		expect(body).toContain("data, never instructions");
	});

	it("renderTitle strips control characters", () => {
		const hostile = ctx({ title: "line1\nline2\tcarriage\rreturn" });
		const title = renderTitle(hostile);
		expect(title).not.toContain("\n");
		expect(title).not.toContain("\t");
		expect(title).not.toContain("\r");
	});

	it("renderDescription includes collapsed-findings children, each escaped", () => {
		const primary = ctx();
		const children = [
			ctx({ fingerprint: "pattern:child1", title: "<b>child one</b>" }),
			ctx({ fingerprint: "pattern:child2", title: "child two" }),
		];
		const body = renderDescription(primary, children);
		expect(body).toContain("Collapsed findings (2)");
		expect(body).not.toContain("<b>child one</b>");
		expect(body).toContain("&lt;b&gt;child one&lt;/b&gt;");
	});
});

describe("Azure DevOps adapter contract (mocked HTTP)", () => {
	it("create-issue: POST json-patch to workitems/$type, pinned api-version + content-type; maps id + html url", async () => {
		const { impl, calls } = mockFetch(200, {
			id: 42,
			_links: {
				html: { href: "https://dev.azure.com/myorg/myproj/_workitems/edit/42" },
			},
		});
		const map = memoryIssueMap();
		const res = await sink({ fetchImpl: impl }).deliver(
			delivery("create-issue"),
			map,
		);
		if (!res.ok) throw new Error(res.error);
		expect(res.externalId).toBe("42");
		expect(res.externalUrl).toBe(
			"https://dev.azure.com/myorg/myproj/_workitems/edit/42",
		);
		expect(calls[0].url).toBe(
			"https://dev.azure.com/myorg/myproj/_apis/wit/workitems/$Bug?api-version=7.0",
		);
		expect(calls[0].init.method).toBe("POST");
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json-patch+json");
		const body = JSON.parse(String(calls[0].init.body)) as Array<{
			op: string;
			path: string;
			value: string;
		}>;
		const title = body.find((op) => op.path === "/fields/System.Title");
		const desc = body.find((op) => op.path === "/fields/System.Description");
		expect(title?.op).toBe("add");
		expect(title?.value).toContain("CalcFields");
		expect(desc?.value).toContain("critical");
		expect(map.entries.get("t1:azureDevOps:pattern:abc123def4567890")).toBe(
			"42",
		);
	});

	it("create-issue includes AreaPath op only when configured", async () => {
		const withArea = mockFetch(200, { id: 1 });
		await sink({
			areaPath: "MyProj\\Team A",
			fetchImpl: withArea.impl,
		}).deliver(delivery("create-issue"), memoryIssueMap());
		const bodyWith = JSON.parse(String(withArea.calls[0].init.body)) as Array<{
			path: string;
			value: string;
		}>;
		const areaOp = bodyWith.find((op) => op.path === "/fields/System.AreaPath");
		expect(areaOp?.value).toBe("MyProj\\Team A");

		const withoutArea = mockFetch(200, { id: 2 });
		await sink({ fetchImpl: withoutArea.impl }).deliver(
			delivery("create-issue", ctx({ fingerprint: "pattern:other" })),
			memoryIssueMap(),
		);
		const bodyWithout = JSON.parse(
			String(withoutArea.calls[0].init.body),
		) as Array<{ path: string }>;
		expect(
			bodyWithout.some((op) => op.path === "/fields/System.AreaPath"),
		).toBe(false);
	});

	it("create-issue sets System.Tags from the (allow-list-filtered) delivery payload labels, semicolon-joined", async () => {
		const { impl, calls } = mockFetch(200, { id: 1 });
		const d = delivery("create-issue");
		d.payload.labels = ["al-perf", "performance"];
		await sink({ fetchImpl: impl }).deliver(d, memoryIssueMap());
		const body = JSON.parse(String(calls[0].init.body)) as Array<{
			path: string;
			value: string;
		}>;
		const tagsOp = body.find((op) => op.path === "/fields/System.Tags");
		expect(tagsOp?.value).toBe("al-perf;performance");
	});

	it("create-issue omits System.Tags op when payload labels is empty", async () => {
		const { impl, calls } = mockFetch(200, { id: 1 });
		const d = delivery("create-issue");
		d.payload.labels = [];
		await sink({ fetchImpl: impl }).deliver(d, memoryIssueMap());
		const body = JSON.parse(String(calls[0].init.body)) as Array<{
			path: string;
		}>;
		expect(body.some((op) => op.path === "/fields/System.Tags")).toBe(false);
	});

	it("create-epic maps every child fingerprint to the same work item, aliasing finding to children[0]", async () => {
		const { impl } = mockFetch(200, { id: 99 });
		const map = memoryIssueMap();
		const epic = delivery("create-epic");
		epic.payload.children = [
			ctx({ fingerprint: "pattern:abc123def4567890" }),
			ctx({ fingerprint: "pattern:child2" }),
		];
		const res = await sink({ fetchImpl: impl }).deliver(epic, map);
		expect(res.ok).toBe(true);
		expect(map.entries.get("t1:azureDevOps:pattern:abc123def4567890")).toBe(
			"99",
		);
		expect(map.entries.get("t1:azureDevOps:pattern:child2")).toBe("99");
	});

	it("comment-regressed: POST to workItems/{id}/comments with preview api-version; no mapping is non-retryable", async () => {
		const { impl, calls } = mockFetch(200, { id: 1 });
		const map = memoryIssueMap();
		const s = sink({ fetchImpl: impl });

		let res = await s.deliver(delivery("comment-regressed"), map);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.retryable).toBe(false);

		map.putIssueMapping({
			tenant: "t1",
			sink: "azureDevOps",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		res = await s.deliver(delivery("comment-regressed"), map);
		expect(res.ok).toBe(true);
		expect(calls[0].url).toBe(
			"https://dev.azure.com/myorg/myproj/_apis/wit/workItems/42/comments?api-version=7.0-preview.3",
		);
		expect(calls[0].init.method).toBe("POST");
		const body = JSON.parse(String(calls[0].init.body)) as { text: string };
		expect(body.text).toContain("regressed");
	});

	it("comment-resolved and comment-recurred route to the same comments endpoint with distinct bodies", async () => {
		const map = memoryIssueMap();
		map.putIssueMapping({
			tenant: "t1",
			sink: "azureDevOps",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});

		const resolved = mockFetch(200, { id: 1 });
		await sink({ fetchImpl: resolved.impl }).deliver(
			delivery(
				"comment-resolved",
				ctx({ resolvedAt: "2026-07-08T00:00:00Z", state: "resolved" }),
			),
			map,
		);
		const resolvedBody = JSON.parse(String(resolved.calls[0].init.body)) as {
			text: string;
		};
		expect(resolvedBody.text).toContain("Not observed since 2026-07-08");

		const recurred = mockFetch(200, { id: 1 });
		await sink({ fetchImpl: recurred.impl }).deliver(
			delivery("comment-recurred", ctx({ occurrenceCount: 6 })),
			map,
		);
		const recurredBody = JSON.parse(String(recurred.calls[0].init.body)) as {
			text: string;
		};
		expect(recurredBody.text.toLowerCase()).toContain("recurred");
		expect(recurredBody.text).toContain("6");
	});

	it("close-issue: PATCHes workitems/{id} with System.State = closedState (json-patch content-type)", async () => {
		const map = memoryIssueMap();
		map.putIssueMapping({
			tenant: "t1",
			sink: "azureDevOps",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		const { impl, calls } = mockFetch(200, { id: 42 });
		const res = await sink({ fetchImpl: impl, closedState: "Done" }).deliver(
			delivery("close-issue"),
			map,
		);
		expect(res.ok).toBe(true);
		expect(calls[0].url).toBe(
			"https://dev.azure.com/myorg/myproj/_apis/wit/workitems/42?api-version=7.0",
		);
		expect(calls[0].init.method).toBe("PATCH");
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json-patch+json");
		const body = JSON.parse(String(calls[0].init.body));
		expect(body).toEqual([
			{ op: "add", path: "/fields/System.State", value: "Done" },
		]);
	});

	it("reopen-issue: PATCHes workitems/{id} with System.State = reopenState", async () => {
		const map = memoryIssueMap();
		map.putIssueMapping({
			tenant: "t1",
			sink: "azureDevOps",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		const { impl, calls } = mockFetch(200, { id: 42 });
		const res = await sink({ fetchImpl: impl, reopenState: "New" }).deliver(
			delivery("reopen-issue"),
			map,
		);
		expect(res.ok).toBe(true);
		const body = JSON.parse(String(calls[0].init.body));
		expect(body).toEqual([
			{ op: "add", path: "/fields/System.State", value: "New" },
		]);
	});

	it("reopen-issue with no mapping is non-retryable", async () => {
		const map = memoryIssueMap();
		const { impl } = mockFetch(200, {});
		const res = await sink({ fetchImpl: impl }).deliver(
			delivery("reopen-issue"),
			map,
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.retryable).toBe(false);
	});

	it("close-issue with no mapping is non-retryable", async () => {
		const map = memoryIssueMap();
		const { impl } = mockFetch(200, {});
		const res = await sink({ fetchImpl: impl }).deliver(
			delivery("close-issue"),
			map,
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.retryable).toBe(false);
	});

	it("every request carries Basic auth of base64(':'+token)", async () => {
		const { impl, calls } = mockFetch(200, { id: 1 });
		await sink({ fetchImpl: impl, token: "my-pat-value" }).deliver(
			delivery("create-issue"),
			memoryIssueMap(),
		);
		const headers = calls[0].init.headers as Record<string, string>;
		const expected = `Basic ${Buffer.from(":my-pat-value").toString("base64")}`;
		expect(headers.authorization).toBe(expected);
	});

	it("status mapping: 401/403/404 permanent, 429/5xx retryable, network throw retryable", async () => {
		const map = memoryIssueMap();
		const attempt = async (status: number) => {
			const { impl } = mockFetch(status, { message: "err" });
			return sink({ fetchImpl: impl }).deliver(delivery("create-issue"), map);
		};
		for (const status of [401, 403, 404]) {
			const res = await attempt(status);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.retryable).toBe(false);
		}
		for (const status of [429, 500, 502, 503]) {
			const res = await attempt(status);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.retryable).toBe(true);
		}
		const throwing = (async () => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;
		const res = await sink({ fetchImpl: throwing }).deliver(
			delivery("create-issue"),
			map,
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.retryable).toBe(true);
	});

	// Controller-added requirement (crash-mid-drain double-create mitigation):
	// a create delivery for an already-mapped fingerprint must be treated as
	// already-delivered, performing ZERO fetch calls.
	it("create-issue for an already-mapped fingerprint short-circuits: zero fetch calls, ok result", async () => {
		const { impl, calls } = mockFetch(200, { id: 999 });
		const map = memoryIssueMap();
		map.putIssueMapping({
			tenant: "t1",
			sink: "azureDevOps",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			externalUrl: "https://dev.azure.com/myorg/myproj/_workitems/edit/42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		const res = await sink({ fetchImpl: impl }).deliver(
			delivery("create-issue"),
			map,
		);
		expect(calls.length).toBe(0);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.externalId).toBe("42");
	});

	it("create-epic for an already-mapped fingerprint short-circuits: zero fetch calls, ok result", async () => {
		const { impl, calls } = mockFetch(200, { id: 999 });
		const map = memoryIssueMap();
		map.putIssueMapping({
			tenant: "t1",
			sink: "azureDevOps",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		const epic = delivery("create-epic");
		epic.payload.children = [
			ctx({ fingerprint: "pattern:abc123def4567890" }),
			ctx({ fingerprint: "pattern:child2" }),
		];
		const res = await sink({ fetchImpl: impl }).deliver(epic, map);
		expect(calls.length).toBe(0);
		expect(res.ok).toBe(true);
	});

	it("auth-leak: a decoy PAT never appears in any thrown error or SinkResult output", async () => {
		const decoyPat = "DECOY-PAT-should-never-leak-zzz9999";
		const map = memoryIssueMap();

		// Error path via non-2xx: response text is server-controlled, but our
		// adapter code must never itself interpolate the token into the error.
		const { impl } = mockFetch(500, { message: "internal error" });
		const res = await sink({ fetchImpl: impl, token: decoyPat }).deliver(
			delivery("create-issue"),
			map,
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).not.toContain(decoyPat);

		// Network throw path: even if the thrown error object were to somehow
		// carry ambient details, our adapter must not smuggle the token in.
		const throwing = (async () => {
			throw new Error("some network failure");
		}) as unknown as typeof fetch;
		const res2 = await sink({ fetchImpl: throwing, token: decoyPat }).deliver(
			delivery("create-issue"),
			map,
		);
		expect(res2.ok).toBe(false);
		if (!res2.ok) expect(res2.error).not.toContain(decoyPat);
	});
});
