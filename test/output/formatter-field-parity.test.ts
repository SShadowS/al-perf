import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatAnalysisHtml } from "../../src/cli/formatters/html.js";
import { formatAnalysisMarkdown } from "../../src/cli/formatters/markdown.js";
import { formatAnalysisTerminal } from "../../src/cli/formatters/terminal.js";
import { analyzeProfile } from "../../src/core/analyzer.js";

/**
 * Field-level parity across formatters.
 *
 * `SectionRenderers<T>` already enforces parity at the SECTION level: a
 * formatter that forgets a whole section fails to compile. Nothing enforced
 * parity at the FIELD level, and a field is exactly where the gap hid --
 * `savingsExplanation` was carried on every DetectedPattern, populated on every
 * analysis, and rendered by ZERO formatters. It reached users only through raw
 * JSON. The measured evidence that justifies a savings figure was written into
 * a field nothing displayed.
 *
 * Two checks, because neither is sufficient alone.
 *
 * The STATIC check counts property accesses per formatter. It covers every
 * field including numeric ones, which survive formatTime() as "950.0ms" and so
 * cannot be found by searching output for their value.
 *
 * The RENDER check pushes sentinel strings through each formatter and looks
 * for them in the output. It exists because the static check has two blind
 * spots, both of which were live in this codebase: a field can be referenced
 * in a condition while its emit is deleted (`p.savingsExplanation ? … : ""`
 * with nothing printing it), and a same-named field on a DIFFERENT type can
 * satisfy the search — `.evidence` matched AIFinding's field while
 * DetectedPattern's went unrendered by all three formatters.
 */

const FORMATTERS = [
	"src/cli/formatters/terminal.ts",
	"src/cli/formatters/markdown.ts",
	"src/cli/formatters/html.ts",
] as const;

/**
 * Fields deliberately not rendered by the human-facing formatters. Each needs
 * a reason, because the whole point of this test is that an unexplained
 * omission is a bug rather than a decision.
 */
const EXEMPT: Record<string, string> = {
	// Lifecycle identity, not user-facing content. Consumed by the lifecycle
	// store and the sinks; printing a 16-hex fingerprint helps nobody reading a
	// report.
	fingerprint:
		"identity for the lifecycle store, meaningless in a human report",
	// Ranking signal consumed by the sorter, not a fact about the finding.
	sqlRank: "rank input, already reflected in the order findings appear",
};

/** Strip comments so a field named only in prose does not count as rendered. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function patternFields(): string[] {
	const src = readFileSync("src/types/patterns.ts", "utf8");
	const block = src.match(
		/export interface DetectedPattern \{([\s\S]*?)\n\}/,
	)?.[1];
	if (!block) throw new Error("DetectedPattern interface not found");
	const fields = new Set<string>();
	for (const line of stripComments(block).split("\n")) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/);
		if (m) fields.add(m[1]);
	}
	return [...fields];
}

describe("formatter field parity", () => {
	const fields = patternFields();
	const sources = FORMATTERS.map((f) => ({
		file: f,
		src: stripComments(readFileSync(f, "utf8")),
	}));

	test("the interface is actually being parsed", () => {
		// Guards the regex above: if the parse silently returned nothing, every
		// parity assertion below would vacuously pass.
		expect(fields).toContain("savingsExplanation");
		expect(fields).toContain("suggestion");
		expect(fields.length).toBeGreaterThan(8);
	});

	test("every DetectedPattern field is rendered by every formatter", () => {
		const gaps: string[] = [];
		for (const field of fields) {
			if (field in EXEMPT) continue;
			const missing = sources
				.filter(({ src }) => !new RegExp(`\\.${field}\\b`).test(src))
				.map(({ file }) => file.split("/").pop());
			if (missing.length > 0) {
				gaps.push(`${field} -> missing from ${missing.join(", ")}`);
			}
		}
		expect(gaps).toEqual([]);
	});

	test("string fields actually reach the rendered output, not just the source", async () => {
		// The static check above only proves a field is REFERENCED. That is too
		// weak on its own: deleting the emit but leaving `p.savingsExplanation`
		// in the surrounding ternary still passes it, which is exactly the shape
		// a careless edit produces. String fields survive formatting unchanged,
		// so a sentinel proves the value reaches the user. Numeric fields go
		// through formatTime() (950000 prints as "950.0ms") and stay on the
		// reference check.
		const sentinels: Record<string, string> = {
			id: "SENTINEL-ID",
			title: "SENTINEL-TITLE",
			description: "SENTINEL-DESCRIPTION",
			evidence: "SENTINEL-EVIDENCE",
			suggestion: "SENTINEL-SUGGESTION",
			savingsExplanation: "SENTINEL-EXPLANATION",
			involvedMethods: "SENTINEL-METHOD",
		};
		// Analyze a real fixture, then replace its patterns with one sentinel
		// pattern. Hand-building an AnalysisResult would break every time an
		// unrelated section gains a field.
		const result = await analyzeProfile(
			"test/fixtures/sampling-minimal.alcpuprofile",
		);
		result.patterns = [
			{
				id: sentinels.id,
				severity: "critical",
				title: sentinels.title,
				description: sentinels.description,
				impact: 1_000_000,
				involvedMethods: [sentinels.involvedMethods],
				evidence: sentinels.evidence,
				suggestion: sentinels.suggestion,
				estimatedSavings: 950_000,
				savingsExplanation: sentinels.savingsExplanation,
			},
		];

		const rendered = {
			terminal: formatAnalysisTerminal(result),
			markdown: formatAnalysisMarkdown(result),
			html: formatAnalysisHtml(result),
		};

		const gaps: string[] = [];
		for (const [field, sentinel] of Object.entries(sentinels)) {
			for (const [name, out] of Object.entries(rendered)) {
				if (!out.includes(sentinel)) gaps.push(`${field} -> not in ${name}`);
			}
		}
		expect(gaps).toEqual([]);
	});

	test("every exemption names a field that still exists", () => {
		// An exemption for a deleted field is a stale excuse that would silently
		// cover a future field of the same name.
		for (const field of Object.keys(EXEMPT)) {
			expect(fields).toContain(field);
		}
	});
});
