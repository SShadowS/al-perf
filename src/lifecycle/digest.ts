/**
 * digest.ts — the digest-first reporting output (umbrella spec §4).
 *
 * buildDigest returns a stable JSON shape (DigestData) — this is the
 * contract consumed by the documented `gh issue create` recipe
 * (docs/lifecycle-gh-recipe.md, Plan B) — and renderDigestMarkdown renders
 * the human form. NOT an AnalysisResult section: formatter parity
 * deliberately does not apply.
 */

import {
	STATEMENT_QUERY_LABEL,
	type TelemetryBatchDocument,
} from "../types/telemetry.js";
import type { FindingState } from "./states.js";
import type {
	CaptureQueueHealth,
	FindingRow,
	LifecycleStore,
} from "./store.js";

/** One entry from a telemetry pull's `signalAvailability` array (src/types/telemetry.ts). */
export type SignalAvailabilityEntry = NonNullable<
	TelemetryBatchDocument["signalAvailability"]
>[number];

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
	/**
	 * The `signalAvailability` array from this tenant's most recent telemetry
	 * pull (the same shape `parseTelemetryBatch` validates off the wire — see
	 * src/types/telemetry.ts). Absent (e.g. a tenant with no telemetry pull,
	 * or a caller that hasn't been wired up yet) → `unavailable` and
	 * `truncated` are always `[]` and nothing renders.
	 *
	 * Two rules this option's ONLY consumer (buildDigest, below) must respect:
	 *  - `rows`/`unmatchedRows` on an entry are PULL-WIDE (the whole pull,
	 *    which may span other tenants) — never rendered as tenant-specific
	 *    text, never used to gate a per-tenant "clean" claim. Only a signal's
	 *    own `error` and `truncated` may drive that (F2 fix, final review:
	 *    `truncated` now drives its own sentence, distinct from `error`).
	 *  - The `"RT0005 statements"` entry is the enrichment query — its
	 *    failure does NOT mark a run incomplete (evaluateRun's absence gate
	 *    deliberately excludes it, telemetry-parser.ts's failedSignalQueries
	 *    derivation). It IS reported here as unavailable, but the rendered
	 *    line must not imply findings went unobserved because of it.
	 */
	signalAvailability?: TelemetryBatchDocument["signalAvailability"];
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
	/**
	 * Signals whose query failed on the pull described by
	 * `DigestOptions.signalAvailability` (entries with `error` set) — always
	 * `[]` when the caller didn't supply availability data, or every signal
	 * succeeded. Rendered as one line naming just the signal ids; see
	 * DigestOptions.signalAvailability for the pull-wide-fields and
	 * enrichment-query caveats this must not violate.
	 */
	unavailable: SignalAvailabilityEntry[];
	/**
	 * Signals whose query succeeded (no `error`) but reported `truncated:
	 * true` — App Insights cut the response off at its row cap or returned a
	 * partial-failure marker (F2 fix, final review). A distinct condition
	 * from `unavailable`: the query didn't fail, but its result may be
	 * incomplete, so it gets its own rendered sentence rather than being
	 * silently indistinguishable from a clean, complete result. Always `[]`
	 * when the caller didn't supply availability data, no query truncated, or
	 * an entry's `error` already explains it (covered by `unavailable`
	 * instead — one entry never appears in both).
	 */
	truncated: SignalAvailabilityEntry[];
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

	// Only `error` drives this — never `rows`/`unmatchedRows` (pull-wide, see
	// DigestOptions.signalAvailability). Includes the "RT0005 statements"
	// entry when it failed; renderDigestMarkdown's wording must not imply
	// findings went unobserved for that one (it's enrichment, not identity).
	const unavailable = (opts?.signalAvailability ?? []).filter(
		(s) => s.error !== undefined,
	);
	// F2 fix (final review): `truncated` without `error` — the query
	// succeeded but was cut off. Excludes anything already in `unavailable`
	// so one entry never renders two lines.
	const truncated = (opts?.signalAvailability ?? []).filter(
		(s) => s.truncated === true && s.error === undefined,
	);

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
		unavailable,
		truncated,
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

	// Advisory only, never a "findings might be missing" alarm on its own —
	// see DigestOptions.signalAvailability for why rows/unmatchedRows never
	// appear here. A failed SIGNAL query and a failed "RT0005 statements"
	// ENRICHMENT query get their own sentences (F1 fix, final review): only
	// the former means findings went unobserved / absence isn't counted —
	// the latter means SQL evidence is missing but findings still resolve
	// normally, and must not read as "absence not counted for them".
	const unavailable = digest.unavailable;
	const unavailableSignalQueries = unavailable.filter(
		(s) => s.signalId !== STATEMENT_QUERY_LABEL,
	);
	const unavailableEnrichmentQueries = unavailable.filter(
		(s) => s.signalId === STATEMENT_QUERY_LABEL,
	);
	const unavailableLines: string[] = [];
	if (unavailableSignalQueries.length > 0) {
		unavailableLines.push(
			`> Signals unavailable this window: ${unavailableSignalQueries.map((s) => s.signalId).join(", ")} — absence not counted for them.`,
		);
	}
	if (unavailableEnrichmentQueries.length > 0) {
		unavailableLines.push(
			`> SQL evidence unavailable this window: ${unavailableEnrichmentQueries.map((s) => s.signalId).join(", ")} (findings still counted).`,
		);
	}
	// F2 fix (final review): `truncated` (query succeeded, but was cut off)
	// is distinct from `unavailable` (query failed outright) and renders its
	// own sentence — never silently identical to a clean, complete result.
	if (digest.truncated.length > 0) {
		unavailableLines.push(
			`> SQL evidence truncated this window: ${digest.truncated.map((s) => s.signalId).join(", ")} (query hit its row cap — some slow statements may be missing).`,
		);
	}
	const unavailableBlock: string[] =
		unavailableLines.length > 0 ? [...unavailableLines, ""] : [];

	const header = [
		"# al-perf Finding Digest",
		"",
		`Generated: ${digest.generatedAt}${digest.tenant ? ` · tenant: ${digest.tenant}` : ""}${digest.since ? ` · since: ${digest.since}` : ""}`,
		"",
		...queueBlock,
		...unavailableBlock,
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
