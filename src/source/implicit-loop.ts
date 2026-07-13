/**
 * Shared phrasing/severity helpers for findings raised from an "implicit
 * loop" — a per-row trigger (Report/XMLport/Page `OnAfterGetRecord`) that the
 * BC platform calls once per row, even though nothing in the AL source is
 * syntactically a loop (Task 7). Any collected item that carries an
 * `insideLoop` flag and an optional `implicitLoop` marker (currently
 * `RecordOpInfo`, `DangerousCallInfo`, `ExternalCallInfo`) can use these.
 *
 * Centralized here (rather than duplicated per detector file) because every
 * "X inside a loop" detector needs the identical self-explanation: a finding
 * that just says "inside a loop" against a trigger with no visible loop reads
 * as a tool bug, not a real finding.
 */

/** Structural shape every implicit-loop-aware collected item satisfies. */
export interface ImplicitLoopAware {
	insideLoop: boolean;
	implicitLoop?: string;
}

/**
 * Describe where a collected item runs, for use inside a finding's
 * `description`. An item promoted from a per-row trigger has no
 * `repeat`/`for`/`foreach`/`while` anywhere in the source.
 */
export function loopLocationPhrase(
	item: ImplicitLoopAware,
	line: number,
	file: string,
): string {
	return item.implicitLoop
		? `executes once per row at line ${line} in ${file} — ${item.implicitLoop} is called once per row by the platform, even though there is no repeat/for/foreach/while anywhere in the source`
		: `is called inside a loop at line ${line} in ${file}`;
}

/** Evidence-string counterpart of `loopLocationPhrase`. */
export function loopEvidencePhrase(item: ImplicitLoopAware): string {
	return item.implicitLoop
		? `${item.implicitLoop} runs once per row — this call executes once per row (implicit loop; no syntactic loop in the source)`
		: "inside loop";
}

/**
 * A Page's `OnAfterGetRecord` is bounded by rows rendered (tens), not table
 * rows (millions) like a Report or XMLport dataitem. Same bug shape, an order
 * of magnitude less costly — still worth flagging, but one severity level
 * below the report/XMLport case.
 *
 * `PageExtension` gets the identical downgrade: a pageextension overriding
 * `OnAfterGetRecord` renders the same bounded row count as a base page, and
 * base pages can't be modified in place in BC — extensions are where almost
 * all real partner/ISV page code lives. Matching on `startsWith("Page.")`
 * alone missed `"PageExtension.OnAfterGetRecord"` entirely, so every
 * pageextension kept the report/XMLport-level `critical` severity.
 */
export function downgradePageImplicitLoop(
	severity: "critical" | "warning",
	item: ImplicitLoopAware,
): "critical" | "warning" {
	const isPageImplicitLoop =
		item.implicitLoop?.startsWith("Page.") ||
		item.implicitLoop?.startsWith("PageExtension.");
	return severity === "critical" && isPageImplicitLoop ? "warning" : severity;
}
