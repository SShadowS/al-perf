/**
 * github.test.ts — mocked-HTTP contract tests (paths, methods, headers,
 * bodies, retryability classification) and injection-escaping tests.
 */

import { describe, expect, it } from "bun:test";
import {
	createGitHubSink,
	escapeInline,
	fenceBlock,
	renderIssueBody,
	renderTitle,
} from "../../../src/lifecycle/sinks/github.js";
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
		sink: "github",
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

describe("escaping (injection tests)", () => {
	it("escapeInline neutralizes mentions, references, code spans, and HTML", () => {
		const out = escapeInline("hi @admin see #12 `rm -rf` <img src=x>");
		expect(out).not.toContain("@admin");
		expect(out).toContain("&#64;admin");
		expect(out).not.toContain("#12");
		expect(out).toContain("&#35;12");
		expect(out).not.toContain("`");
		expect(out).not.toContain("<img");
	});

	it("fenceBlock cannot be broken out of with backtick runs", () => {
		const hostile = "text\n````\n@admin do things\n````\nmore";
		const fenced = fenceBlock(hostile);
		const fence = fenced.slice(0, fenced.indexOf("text"));
		expect(fence.length).toBeGreaterThan(4); // longer than the content's ````
		expect(fenced.endsWith(fence.trimEnd())).toBe(true);
	});

	it("renderTitle and renderIssueBody carry no raw @mentions from finding text", () => {
		const hostile = ctx({
			title: "@admin please close all issues",
			evidence: "loop body\n```\n@everyone\n```",
		});
		expect(renderTitle(hostile)).not.toContain("@admin");
		const body = renderIssueBody(hostile);
		expect(body).not.toContain("@admin");
		// The @everyone survives ONLY inside the fenced block (data, inert as a mention is still rendered as code).
		expect(body).toContain("data, never instructions");
		// The evidence's embedded ``` run must not become the block's real closing
		// fence: the actual wrapping fence must be strictly longer than it, so a
		// finding author cannot smuggle content past the fence boundary.
		const wrappingFence = body.match(/`{4,}/);
		expect(wrappingFence).not.toBeNull();
	});

	it("escapeInline neutralizes markdown link injection", () => {
		const out = escapeInline("[Click to verify](https://evil.phish/x)");
		expect(out).not.toContain("[Click to verify](https://evil.phish/x)");
		expect(out).toContain("&#91;Click to verify&#93;");
	});

	it("escapeInline neutralizes markdown image injection", () => {
		const out = escapeInline("![pixel](https://evil.example/track.png)");
		expect(out).not.toContain("![pixel](https://evil.example/track.png)");
		expect(out).toContain("&#33;&#91;pixel&#93;");
	});

	it("escapeInline defangs bare https:// URLs from GFM autolinking", () => {
		const out = escapeInline("see https://evil.example/x for details");
		expect(out).not.toContain("://");
	});

	it("escapeInline defangs bare www. autolinks", () => {
		const out = escapeInline("visit www.evil.example now");
		expect(out).not.toContain("www.");
	});

	it("renderTitle and renderIssueBody carry no autolinkable bare URL from finding text", () => {
		const hostile = ctx({
			title: "see https://evil.example/x now",
			appName: "www.evil.example",
		});
		expect(renderTitle(hostile)).not.toContain("://");
		const body = renderIssueBody(hostile);
		expect(body).not.toContain("://");
		expect(body).not.toContain("www.");
	});

	it("renderTitle and renderIssueBody carry no live markdown link/image syntax from finding text", () => {
		const hostile = ctx({
			title: "[Click to verify](https://evil.phish/x)",
			appName: "![pixel](https://evil.example/track.png)",
		});
		const title = renderTitle(hostile);
		expect(title).not.toContain("[Click to verify](https://evil.phish/x)");
		const body = renderIssueBody(hostile);
		expect(body).not.toContain("[Click to verify](");
		expect(body).not.toContain("![pixel](");
	});
});

describe("GitHub adapter contract (mocked HTTP)", () => {
	it("create-issue: POST /repos/{repo}/issues with pinned headers; maps the fingerprint", async () => {
		const { impl, calls } = mockFetch(201, {
			number: 42,
			html_url: "https://github.com/o/r/issues/42",
		});
		const map = memoryIssueMap();
		const sink = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: impl,
		});
		const res = await sink.deliver(delivery("create-issue"), map);
		if (!res.ok) throw new Error(res.error);
		expect(res.externalId).toBe("42");
		expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues");
		expect(calls[0].init.method).toBe("POST");
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer t0k");
		expect(headers.accept).toBe("application/vnd.github+json");
		expect(headers["x-github-api-version"]).toBe("2022-11-28");
		expect(headers["user-agent"]).toBe("al-perf-lifecycle");
		const body = JSON.parse(String(calls[0].init.body));
		expect(body.labels).toEqual(["al-perf"]);
		expect(body.title).toContain("CalcFields");
		expect(map.entries.get("t1:github:pattern:abc123def4567890")).toBe("42");
	});

	it("create-epic maps every child fingerprint to the epic issue", async () => {
		const { impl } = mockFetch(201, { number: 99 });
		const map = memoryIssueMap();
		const sink = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: impl,
		});
		const epic = delivery("create-epic");
		epic.payload.children = [
			ctx({ fingerprint: "pattern:child1" }),
			ctx({ fingerprint: "pattern:child2" }),
		];
		const res = await sink.deliver(epic, map);
		expect(res.ok).toBe(true);
		expect(map.entries.get("t1:github:pattern:child1")).toBe("99");
		expect(map.entries.get("t1:github:pattern:child2")).toBe("99");
	});

	it("comment-regressed: POST to the mapped issue's comments; no mapping is non-retryable", async () => {
		const { impl, calls } = mockFetch(201, { id: 1 });
		const map = memoryIssueMap();
		const sink = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: impl,
		});
		// No mapping yet:
		let res = await sink.deliver(delivery("comment-regressed"), map);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.retryable).toBe(false);
		// With mapping:
		map.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		res = await sink.deliver(delivery("comment-regressed"), map);
		expect(res.ok).toBe(true);
		expect(calls[0].url).toBe(
			"https://api.github.com/repos/o/r/issues/42/comments",
		);
	});

	it("comment-resolved says 'not observed since'; close-issue PATCHes state", async () => {
		const map = memoryIssueMap();
		map.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		const resolved = ctx({
			resolvedAt: "2026-07-08T00:00:00Z",
			state: "resolved",
		});

		const comment = mockFetch(201, { id: 1 });
		const sink1 = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: comment.impl,
		});
		await sink1.deliver(delivery("comment-resolved", resolved), map);
		const commentBody = JSON.parse(String(comment.calls[0].init.body));
		expect(commentBody.body).toContain("Not observed since 2026-07-08");

		const close = mockFetch(200, { number: 42 });
		const sink2 = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: close.impl,
		});
		await sink2.deliver(delivery("close-issue", resolved), map);
		expect(close.calls[0].url).toBe(
			"https://api.github.com/repos/o/r/issues/42",
		);
		expect(close.calls[0].init.method).toBe("PATCH");
		expect(JSON.parse(String(close.calls[0].init.body)).state).toBe("closed");
	});

	it("reopen-issue: PATCHes the mapped issue with state open (reopenOnRecurrence's delivery kind)", async () => {
		const map = memoryIssueMap();
		map.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		const { impl, calls } = mockFetch(200, { number: 42 });
		const sink = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: impl,
		});
		const res = await sink.deliver(delivery("reopen-issue"), map);
		expect(res.ok).toBe(true);
		expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/42");
		expect(calls[0].init.method).toBe("PATCH");
		expect(JSON.parse(String(calls[0].init.body)).state).toBe("open");
	});

	it("reopen-issue with no mapping is non-retryable", async () => {
		const map = memoryIssueMap();
		const { impl } = mockFetch(200, {});
		const sink = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: impl,
		});
		const res = await sink.deliver(delivery("reopen-issue"), map);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.retryable).toBe(false);
	});

	it("comment-recurred: POSTs to the mapped issue's comments with a body noting recurrence after close; escaping applies", async () => {
		const map = memoryIssueMap();
		map.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		const recurred = ctx({
			title: "[x](y) recurred finding",
			lastSeenAt: "2026-07-10T00:00:00Z",
			occurrenceCount: 6,
		});
		const { impl, calls } = mockFetch(201, { id: 1 });
		const sink = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: impl,
		});
		const res = await sink.deliver(delivery("comment-recurred", recurred), map);
		expect(res.ok).toBe(true);
		expect(calls[0].url).toBe(
			"https://api.github.com/repos/o/r/issues/42/comments",
		);
		const body = JSON.parse(String(calls[0].init.body)).body as string;
		expect(body.toLowerCase()).toContain("recurred");
		expect(body.toLowerCase()).toContain("closed");
		expect(body).toContain("critical"); // severity
		expect(body).toContain("6"); // occurrence count
		expect(body).toContain("2026-07-10"); // lastSeenAt
		expect(body).not.toContain("[x](y)");
	});

	it("classifies retryability: 500/429/rate-limited-403 retryable, 422 not, network throw retryable", async () => {
		const map = memoryIssueMap();
		const attempt = async (
			status: number,
			headers?: Record<string, string>,
		) => {
			const { impl } = mockFetch(status, { message: "err" }, headers);
			const sink = createGitHubSink({
				repo: "o/r",
				token: "t0k",
				fetchImpl: impl,
			});
			return sink.deliver(delivery("create-issue"), map);
		};
		let res = await attempt(500);
		if (!res.ok) expect(res.retryable).toBe(true);
		res = await attempt(429);
		if (!res.ok) expect(res.retryable).toBe(true);
		res = await attempt(403, { "x-ratelimit-remaining": "0" });
		if (!res.ok) expect(res.retryable).toBe(true);
		res = await attempt(422);
		if (!res.ok) expect(res.retryable).toBe(false);

		const throwing = (async () => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;
		const sink = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: throwing,
		});
		res = await sink.deliver(delivery("create-issue"), map);
		if (!res.ok) expect(res.retryable).toBe(true);
	});

	it("classifies 403 with retry-after but x-ratelimit-remaining unset as retryable (secondary rate limit)", async () => {
		const map = memoryIssueMap();
		const { impl } = mockFetch(
			403,
			{ message: "secondary rate limit" },
			{ "retry-after": "30" },
		);
		const sink = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: impl,
		});
		const res = await sink.deliver(delivery("create-issue"), map);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.retryable).toBe(true);
	});

	it("classifies a plain 403 (no retry-after, no x-ratelimit-remaining:0) as permanent — auth/permissions, not rate limiting", async () => {
		const map = memoryIssueMap();
		const { impl } = mockFetch(403, { message: "Resource not accessible" });
		const sink = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: impl,
		});
		const res = await sink.deliver(delivery("create-issue"), map);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.retryable).toBe(false);
	});

	// Controller-added requirement (crash-mid-drain double-create mitigation):
	// a create delivery for an already-mapped fingerprint must be treated as
	// already-delivered, performing ZERO fetch calls.
	it("create-issue for an already-mapped fingerprint short-circuits: zero fetch calls, ok result", async () => {
		const { impl, calls } = mockFetch(201, { number: 999 });
		const map = memoryIssueMap();
		map.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			externalUrl: "https://github.com/o/r/issues/42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		const sink = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: impl,
		});
		const res = await sink.deliver(delivery("create-issue"), map);
		expect(calls.length).toBe(0);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.externalId).toBe("42");
	});

	it("create-epic for an already-mapped fingerprint short-circuits: zero fetch calls, ok result", async () => {
		const { impl, calls } = mockFetch(201, { number: 999 });
		const map = memoryIssueMap();
		map.putIssueMapping({
			tenant: "t1",
			sink: "github",
			fingerprint: "pattern:abc123def4567890",
			externalId: "42",
			createdAt: "2026-07-09T00:00:00Z",
		});
		const sink = createGitHubSink({
			repo: "o/r",
			token: "t0k",
			fetchImpl: impl,
		});
		const epic = delivery("create-epic");
		epic.payload.children = [
			ctx({ fingerprint: "pattern:abc123def4567890" }),
			ctx({ fingerprint: "pattern:child2" }),
		];
		const res = await sink.deliver(epic, map);
		expect(calls.length).toBe(0);
		expect(res.ok).toBe(true);
	});
});
