import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { formatBatchMarkdown } from "../../../src/cli/formatters/batch-markdown.js";
import { formatAnalysisMarkdown } from "../../../src/cli/formatters/markdown.js";
import { analyzeProfile } from "../../../src/core/analyzer.js";
import { analyzeBatch } from "../../../src/core/batch-analyzer.js";

const REAL = "test/fixtures/batch-recorded/profile-3.alcpuprofile";

/**
 * A BC sampling profile embeds SQL statements as call-tree nodes whose
 * functionName IS the statement — over a thousand characters of it. terminal,
 * html, batch-terminal and batch-html all pass those through
 * truncateFunctionName; markdown and batch-markdown did not, so the statement
 * went into a table CELL verbatim. It destroys the table, and markdown is the
 * format most likely to be pasted into a pull request or a ticket.
 */
function longestTableCell(md: string): number {
	let longest = 0;
	for (const line of md.split("\n")) {
		if (!line.startsWith("|")) continue;
		for (const cell of line.split("|")) {
			longest = Math.max(longest, cell.trim().length);
		}
	}
	return longest;
}

describe("markdown formatter — SQL node names", () => {
	// Guarded because test/fixtures/batch-recorded/ is gitignored real capture
	// data: absent on a fresh clone and in CI, where an unguarded read is an
	// ENOENT rather than a skip.
	test.skipIf(!existsSync(REAL))(
		"no table cell carries a whole SQL statement",
		async () => {
			const result = await analyzeProfile(REAL, { top: 20 });
			const md = formatAnalysisMarkdown(result);
			expect(longestTableCell(md)).toBeLessThan(200);
		},
	);

	test.skipIf(!existsSync(REAL))("batch markdown too", async () => {
		const result = await analyzeBatch([REAL, REAL], { top: 20 });
		const md = formatBatchMarkdown(result);
		expect(longestTableCell(md)).toBeLessThan(200);
	});
});
