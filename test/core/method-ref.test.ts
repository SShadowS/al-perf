import { describe, expect, test } from "bun:test";
import { formatMethodBreakdownRef } from "../../src/core/method-ref.js";
import { formatMethodBreakdownRef as reExported } from "../../src/core/patterns.js";

/**
 * This format was duplicated in two modules — `core/patterns.ts` and
 * `semantic/corroborate.ts` — with a comment in the copy asking a future reader
 * not to let them drift. It is now defined once, and these tests pin the two
 * properties that made the duplication risky.
 *
 * The output is `involvedMethods`, the finding-lifecycle fingerprint anchor. A
 * single changed byte severs every stored finding's identity: the old finding
 * resolves as gone and the same problem resurfaces as new, taking its triage
 * history with it. That is why this is pinned by exact string rather than by
 * shape.
 */
describe("formatMethodBreakdownRef", () => {
	test("emits the exact fingerprint-anchor format", () => {
		expect(
			formatMethodBreakdownRef({
				functionName: "PostSalesLines",
				objectType: "Codeunit",
				objectId: 80,
			}),
		).toBe("PostSalesLines (Codeunit 80)");
	});

	test("patterns.ts re-export is the same function, not a second copy", () => {
		// core/patterns.ts kept exporting this name so existing importers did not
		// break. If someone later reintroduces a local definition there, this
		// identity check fails while a string comparison would not.
		expect(reExported).toBe(formatMethodBreakdownRef);
	});

	test("formats a method whose name contains characters BC really emits", () => {
		// Trigger and event-subscriber names carry punctuation; the anchor has to
		// survive them unaltered rather than being sanitised.
		expect(
			formatMethodBreakdownRef({
				functionName: 'OnAfterPostSalesDoc."Sales Header"',
				objectType: "Table",
				objectId: 36,
			}),
		).toBe('OnAfterPostSalesDoc."Sales Header" (Table 36)');
	});
});
