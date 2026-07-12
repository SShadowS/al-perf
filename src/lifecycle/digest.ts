/**
 * digest.ts — the digest-first reporting output (umbrella spec §4).
 *
 * buildDigest returns a stable JSON shape (DigestData) — this is the
 * contract consumed by the documented `gh issue create` recipe
 * (docs/lifecycle-gh-recipe.md, Plan B) — and renderDigestMarkdown renders
 * the human form. NOT an AnalysisResult section: formatter parity
 * deliberately does not apply.
 */

import type { FindingState } from "./states.js";
import type {
	CaptureQueueHealth,
	FindingRow,
	LifecycleStore,
} from "./store.js";

export interface DigestOptions {
	tenant?: string;
	/** ISO timestamp — filter sections to activity at/after this time. */
	since?: string;
	/** Clock override for tests; defaults to the current time. */
	now?: string;
	/** Per-section cap (default 50). */
	limit?: number;
	/**
	 * Capture-request queue config, needed to compute captureQueue health.
	 * Absent (e.g. an older caller that hasn't been updated) → captureQueue
	 * is always null and nothing renders.
	 */
	captureRequests?: { claimTtlMinutes: number; maxPending: number };
}

export interface DigestFindingEntry {
	fingerprint: string;
	title: string;
	severity: string;
	state: string;
	needsTriage: boolean;
	appName: string;
	patternId: string;
	firstSeenAt: string;
	lastSeenAt: string;
	occurrenceCount: number;
	lastEvent: string | null;
}

export interface DigestData {
	generatedAt: string;
	tenant: string | null;
	since: string | null;
	totals: {
		new: number;
		open: number;
		regressed: number;
		improving: number;
		resolved: number;
		closed: number;
		needsTriage: number;
	};
	newFindings: DigestFindingEntry[];
	regressed: DigestFindingEntry[];
	improving: DigestFindingEntry[];
	resolved: DigestFindingEntry[];
	needsTriage: DigestFindingEntry[];
	/**
	 * Queue health for the digest's tenant, or null when the digest is not
	 * tenant-scoped, the tenant has no capture requests, or the caller did not
	 * supply the capture config. Rendered ONLY when jammed — see
	 * renderDigestMarkdown.
	 */
	captureQueue: CaptureQueueHealth | null;
}

function toEntry(store: LifecycleStore, row: FindingRow): DigestFindingEntry {
	const events = store.listEvents(row.id);
	return {
		fingerprint: row.fingerprint,
		title: row.title,
		severity: row.severity,
		state: row.state,
		needsTriage: row.needsTriage,
		appName: row.appName,
		patternId: row.patternId,
		firstSeenAt: row.firstSeenAt,
		lastSeenAt: row.lastSeenAt,
		occurrenceCount: store.countOccurrences(row.id),
		lastEvent: events.length > 0 ? events[events.length - 1].event : null,
	};
}

export function buildDigest(
	store: LifecycleStore,
	opts?: DigestOptions,
): DigestData {
	const limit = opts?.limit ?? 50;
	const tenant = opts?.tenant;
	const since = opts?.since ?? null;

	const byState = (state: FindingState): FindingRow[] =>
		store.listFindings({ tenant, state });

	const totals = {
		new: byState("new").length,
		open: byState("open").length,
		regressed: byState("regressed").length,
		improving: byState("improving").length,
		resolved: byState("resolved").length,
		closed: byState("closed").length,
		needsTriage: store.listFindings({ tenant, needsTriage: true }).length,
	};

	const section = (
		state: FindingState,
		timeOf: (row: FindingRow) => string | null,
	): DigestFindingEntry[] =>
		byState(state)
			.filter((row) => {
				if (!since) return true;
				const t = timeOf(row);
				return t !== null && t >= since;
			})
			.slice(0, limit)
			.map((row) => toEntry(store, row));

	const generatedAt = opts?.now ?? new Date().toISOString();

	let captureQueue: CaptureQueueHealth | null = null;
	if (tenant && opts?.captureRequests) {
		const [h] = store.captureQueueHealth(
			generatedAt,
			opts.captureRequests.claimTtlMinutes,
			opts.captureRequests.maxPending,
			tenant,
		);
		captureQueue = h ?? null;
	}

	return {
		generatedAt,
		tenant: tenant ?? null,
		since,
		totals,
		newFindings: section("new", (r) => r.firstSeenAt),
		regressed: section("regressed", (r) => r.lastSeenAt),
		improving: section("improving", (r) => r.lastSeenAt),
		resolved: section("resolved", (r) => r.resolvedAt),
		needsTriage: store
			.listFindings({ tenant, needsTriage: true, limit })
			.map((row) => toEntry(store, row)),
		captureQueue,
	};
}

/** Neutralizes markdown link/emphasis/table syntax and @-mentions in
 * attacker-influenceable finding text (routine names, titles) so it can't
 * break out of list/table formatting, inject links, or ping a GitHub user
 * when rendered through the gh-recipe (docs/lifecycle-gh-recipe.md). */
function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_[\]<>|@]/g, (ch) => `\\${ch}`);
}

function renderSection(title: string, entries: DigestFindingEntry[]): string {
	const lines = [`## ${title}`, ""];
	if (entries.length === 0) {
		lines.push("_none_", "");
		return lines.join("\n");
	}
	for (const e of entries) {
		const triage = e.needsTriage ? " [needs-triage]" : "";
		lines.push(
			`- **[${e.severity}]** ${escapeMarkdown(e.title)}${triage}`,
			`  \`${e.fingerprint}\` · ${escapeMarkdown(e.patternId)} · ${escapeMarkdown(e.appName) || "unknown app"} · seen ${e.occurrenceCount}x · first ${e.firstSeenAt.slice(0, 10)} · last ${e.lastSeenAt.slice(0, 10)}`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

export function renderDigestMarkdown(digest: DigestData): string {
	const t = digest.totals;

	// ONLY when jammed. A section that always renders would push routine queue
	// chatter into every GitHub/ADO issue the digest drives, and the whole digest
	// gets ignored inside a month.
	const q = digest.captureQueue;
	const jammed = q !== null && (q.atCap || q.stuck > 0);
	const queueBlock = jammed
		? [
				"> **⚠ Capture queue jammed.**",
				`> ${q.pending} pending, ${q.claimed} claimed (${q.stuck} stuck)${
					q.atCap ? `, at the maxPending cap (${q.maxPending})` : ""
				}.`,
				q.atCap
					? "> New capture requests are NOT being filed while the queue is at the cap."
					: "",
				q.stuckHolders.length > 0
					? `> Stuck claims last held by: ${q.stuckHolders.join(", ")}.`
					: "",
				"> Run `lifecycle captures health` for detail.",
				"",
			].filter((line) => line !== "")
		: [];

	const header = [
		"# al-perf Finding Digest",
		"",
		`Generated: ${digest.generatedAt}${digest.tenant ? ` · tenant: ${digest.tenant}` : ""}${digest.since ? ` · since: ${digest.since}` : ""}`,
		"",
		...queueBlock,
		`| new | open | regressed | improving | resolved | closed | needs-triage |`,
		`|---|---|---|---|---|---|---|`,
		`| ${t.new} | ${t.open} | ${t.regressed} | ${t.improving} | ${t.resolved} | ${t.closed} | ${t.needsTriage} |`,
		"",
	].join("\n");
	return [
		header,
		renderSection("New findings", digest.newFindings),
		renderSection("Regressed", digest.regressed),
		renderSection("Improving", digest.improving),
		renderSection("Resolved", digest.resolved),
		renderSection("Needs triage", digest.needsTriage),
	].join("\n");
}
