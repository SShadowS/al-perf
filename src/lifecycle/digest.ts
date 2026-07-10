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
import type { FindingRow, LifecycleStore } from "./store.js";

export interface DigestOptions {
	tenant?: string;
	/** ISO timestamp — filter sections to activity at/after this time. */
	since?: string;
	/** Clock override for tests; defaults to the current time. */
	now?: string;
	/** Per-section cap (default 50). */
	limit?: number;
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

	return {
		generatedAt: opts?.now ?? new Date().toISOString(),
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
	};
}

/** Neutralizes markdown link/emphasis/table syntax in attacker-influenceable
 * finding text (routine names, titles) so it can't break out of list/table
 * formatting or inject links when rendered. */
function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_[\]<>|]/g, (ch) => `\\${ch}`);
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
	const header = [
		"# al-perf Finding Digest",
		"",
		`Generated: ${digest.generatedAt}${digest.tenant ? ` · tenant: ${digest.tenant}` : ""}${digest.since ? ` · since: ${digest.since}` : ""}`,
		"",
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
