/**
 * tenant.ts — canonical tenant-code normalization for the lifecycle layer
 * (debt-closure plan D1). `--tenant Pilot2` and `--tenant pilot2` used to
 * create two case-distinct SQLite tenants that silently split a finding's
 * history — every tenant-keyed read/write now goes through this function
 * first.
 *
 * Mirrors web/storage.ts's `normalizeTenantCode` (lowercase), but is a
 * deliberate duplicate rather than an import: src/lifecycle must not depend
 * on web/ (layering — see CLAUDE.md). Extended with trim + reject-empty
 * because the CLI `--tenant` flag, unlike web's header-sourced tenant code,
 * is free-form operator input.
 *
 * Existing mixed-case tenant data already on disk is NOT migrated by this
 * function — operators should standardize on lowercase `--tenant` values
 * going forward (see CLAUDE.md's lifecycle/ note).
 */

export function normalizeTenantCode(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new Error(
			"tenant code must not be empty (after trimming whitespace)",
		);
	}
	return trimmed.toLowerCase();
}
