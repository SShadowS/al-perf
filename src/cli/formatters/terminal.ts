import chalk from "chalk";
import Table from "cli-table3";
import { formatTime } from "../../core/analyzer.js";
import { truncateFunctionName } from "../../core/display-utils.js";
import type { SectionRenderers } from "../../output/sections.js";
import { SECTION_ORDER } from "../../output/sections.js";
import type { AnalysisResult, ComparisonResult } from "../../output/types.js";
import type {
	AnnotatedRegression,
	DiffDeltaSummary,
	MethodMatch,
	RegressionFusion,
} from "../../semantic/regression-correlate.js";
import type {
	CausalStep,
	FusionViews,
	HotspotAnnotation,
	PrioritizedFinding,
} from "../../semantic/views.js";
import type { MethodBreakdown } from "../../types/aggregated.js";

/**
 * Build the "runtime-correlated" badge string for a list of pattern ids.
 * Returns "" when patterns is absent or empty (byte-unchanged off).
 * Badge text is ALWAYS "runtime-correlated" — NEVER "runtime-confirmed" (R3-6).
 */
function runtimeCorrelatedBadge(patterns: string[] | undefined): string {
	if (!patterns || patterns.length === 0) return "";
	return ` ⚡ runtime-correlated (${patterns.join(", ")})`;
}

/**
 * Build a simple bar chart string using filled/empty blocks.
 */
function bar(percent: number, width: number = 20): string {
	const filled = Math.round((percent / 100) * width);
	const empty = width - filled;
	return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

/**
 * Format severity with appropriate color and icon.
 */
function formatSeverity(severity: "critical" | "warning" | "info"): string {
	switch (severity) {
		case "critical":
			return chalk.red("\u2716 CRITICAL");
		case "warning":
			return chalk.yellow("\u26A0 WARNING");
		case "info":
			return chalk.blue("\u2139 INFO");
	}
}

function renderSummary(result: AnalysisResult): string {
	const lines: string[] = [];
	lines.push(chalk.bold("Summary"));
	lines.push(`  ${result.summary.oneLiner}`);
	const sourceTag = result.meta.sourceAvailable
		? chalk.green("source available")
		: chalk.gray("no source");
	lines.push(
		`  Type: ${result.meta.profileType} | Nodes: ${result.meta.totalNodes} nodes | Max Depth: ${result.meta.maxDepth} | ${sourceTag}`,
	);
	if (result.meta.samplingInterval !== undefined) {
		lines.push(
			`  Sampling Interval: ${formatTime(result.meta.samplingInterval)}`,
		);
	}
	if (
		result.meta.builtinSelfTime !== undefined &&
		result.meta.builtinSelfTime > 0
	) {
		lines.push(
			`  Built-in overhead: ${formatTime(result.meta.builtinSelfTime)}`,
		);
	}
	lines.push(`  Confidence: ${result.meta.confidenceScore}/100`);
	lines.push(`  Health: ${result.summary.healthScore}/100`);
	return lines.join("\n");
}

/**
 * Build the per-hotspot static-cause annotation line (R2-4, R2-5, R2-9/R2-10).
 * Never mutates result.hotspots[i]; returns "" when fusionViews is absent.
 */
function fusionAnnotationLine(
	annotation: HotspotAnnotation | undefined,
): string {
	if (!annotation) return "";
	if (annotation.status === "blind-spot") {
		return chalk.gray(
			`    ↳ not statically analyzed${annotation.reason ? ` (${annotation.reason})` : ""}`,
		);
	}
	if (annotation.status === "ambiguous") {
		return chalk.yellow(
			`    ↳ ${annotation.findings.length} possible static cause(s) (ambiguous)`,
		);
	}
	// matched
	const badge = runtimeCorrelatedBadge(annotation.corroboratingPatterns);
	if (annotation.findings.length === 0) {
		// R2-9: never imply clean unless matchedClean === true
		if (annotation.matchedClean === true) {
			return chalk.green(`    ↳ analyzed, no static findings${badge}`);
		}
		return chalk.gray(
			`    ↳ matched; ${annotation.reason ?? "coverage incomplete"}${badge}`,
		);
	}
	const findingLines = annotation.findings
		.map((f) =>
			chalk.cyan(
				`    ↳ [${f.detector}] ${f.title} @ ${f.primaryLocation.file}:${f.primaryLocation.line}` +
					` (${f.severity}/${f.confidence.level})`,
			),
		)
		.join("\n");
	return badge ? findingLines + chalk.cyan(badge) : findingLines;
}

function renderHotspots(result: AnalysisResult): string {
	if (result.hotspots.length === 0) return "";

	const lines: string[] = [];
	lines.push(chalk.bold("Top Hotspots"));

	const hotspotsTable = new Table({
		head: [
			chalk.gray("#"),
			chalk.gray("Function"),
			chalk.gray("Object"),
			chalk.gray("App"),
			chalk.gray("Self Time"),
			chalk.gray("Total Time"),
			chalk.gray("Hits"),
			chalk.gray("Called By"),
		],
		style: { head: [], border: [] },
	});

	result.hotspots.forEach((h: MethodBreakdown, i: number) => {
		const selfTimeStr = `${formatTime(h.selfTime)} (${h.selfTimePercent.toFixed(1)}%)`;
		const gapStr =
			h.gapTime && h.gapTime > 0
				? chalk.yellow(` +${formatTime(h.gapTime)} wait`)
				: "";
		const objectStr = h.sourceLocation
			? `${h.objectType} ${h.objectId}\n${chalk.gray(h.sourceLocation.filePath + ":" + h.sourceLocation.lineStart)}`
			: `${h.objectType} ${h.objectId} (${h.objectName})`;
		hotspotsTable.push([
			String(i + 1),
			chalk.white.bold(truncateFunctionName(h.functionName, 80)),
			objectStr,
			h.appName,
			selfTimeStr + gapStr,
			`${formatTime(h.totalTime)} (${h.totalTimePercent.toFixed(1)}%)`,
			String(h.hitCount),
			h.calledBy.length > 0 ? h.calledBy.slice(0, 3).join(", ") : "-",
		]);
	});

	lines.push(hotspotsTable.toString());

	// In-place static-cause annotations (R2-4, R2-5: read fusionViews, never mutate hotspots[i])
	if (result.fusionViews) {
		// Build a fast lookup map: attrKey → annotation
		const annMap = new Map(
			result.fusionViews.hotspotAnnotations.map((a) => [a.attrKey, a]),
		);
		const annotationLines: string[] = [];
		result.hotspots.forEach((h: MethodBreakdown) => {
			const key = `${h.functionName}_${h.objectType}_${h.objectId}`;
			const line = fusionAnnotationLine(annMap.get(key));
			if (line) annotationLines.push(line);
		});
		if (annotationLines.length > 0) {
			lines.push(chalk.gray("Static-cause annotations:"));
			lines.push(...annotationLines);
		}
	}

	return lines.join("\n");
}

/**
 * Render the causal chain for a prioritized finding (P3.2b).
 * Returns "" when causalSteps is absent or empty (byte-unchanged off).
 * Format: each step on its own line: `  ↳ <note> @ <routineName> (self%/total%)`
 * Hot steps are marked with ⚡. Unresolved steps show the file:line only.
 */
function renderCausalChain(steps: CausalStep[] | undefined): string {
	if (!steps || steps.length === 0) return "";
	const lines: string[] = [];
	for (const s of steps) {
		const loc = `${s.file}:${s.line}`;
		const hotMark = s.isHot ? chalk.yellow("⚡ ") : "";
		if (s.routineName !== undefined) {
			const pct =
				s.selfTimePercent !== undefined && s.totalTimePercent !== undefined
					? ` (${s.selfTimePercent.toFixed(1)}%/${s.totalTimePercent.toFixed(1)}%)`
					: "";
			const routine = `${s.routineName}`;
			lines.push(
				chalk.gray(`    ↳ ${hotMark}${s.note} @ `) +
					chalk.cyan(`${routine}`) +
					chalk.gray(`${pct} [${loc}]`),
			);
		} else {
			// Unresolved step — show note and location only
			lines.push(chalk.gray(`    ↳ ${hotMark}${s.note} [${loc}]`));
		}
		// Truncation marker (P3.2b): a capped chain (MCP) is non-contiguous here.
		if (s.omittedAfter !== undefined && s.omittedAfter > 0) {
			lines.push(
				chalk.gray(`    ⋮ (${s.omittedAfter} intermediate step(s) elided)`),
			);
		}
	}
	return lines.join("\n");
}

function renderFusionFindingTitle(p: PrioritizedFinding): string {
	const amb =
		p.frameCount > 1 ? chalk.yellow(` (×${p.frameCount} ambiguous)`) : "";
	const badge =
		p.corroboratingPatterns && p.corroboratingPatterns.length > 0
			? chalk.cyan(runtimeCorrelatedBadge(p.corroboratingPatterns))
			: "";
	return chalk.white(p.finding.title) + amb + badge;
}

function renderFusion(result: AnalysisResult): string {
	const fv = result.fusionViews;
	if (!fv || fv.prioritizedFindings.length === 0) return "";

	const lines: string[] = [chalk.bold("Runtime-Prioritized Static Findings")];
	const table = new Table({
		head: ["#", "Finding", "Detector", "Routine", "Self%", "Total%", "Sev"].map(
			(h) => chalk.gray(h),
		),
		style: { head: [], border: [] },
	});

	fv.prioritizedFindings.forEach((p, i) => {
		const orch = p.efficiencyScore < 0.5 ? chalk.gray(" (orchestrator)") : "";
		table.push([
			String(i + 1),
			renderFusionFindingTitle(p),
			p.finding.detector,
			`${p.functionName}${orch}`,
			p.selfTimePercent.toFixed(1),
			p.totalTimePercent.toFixed(1),
			p.finding.severity,
		]);
	});

	lines.push(table.toString());

	// P3.2b: render causal chains under the table (gated on causalSteps present).
	fv.prioritizedFindings.forEach((p, i) => {
		const chain = renderCausalChain(p.causalSteps);
		if (chain) {
			lines.push(chalk.gray(`  Finding #${i + 1} causal chain:`));
			lines.push(chain);
		}
	});

	return lines.join("\n");
}

function renderCriticalPath(result: AnalysisResult): string {
	if (!result.criticalPath || result.criticalPath.length <= 1) return "";

	const lines: string[] = [];
	lines.push(chalk.bold("Critical Path"));
	lines.push("");
	for (const step of result.criticalPath) {
		const indent = "  ".repeat(step.depth + 1);
		const arrow = step.depth > 0 ? "\u2514\u2500 " : "";
		lines.push(
			`${indent}${arrow}${chalk.white.bold(step.functionName)} (${step.objectType} ${step.objectId}) \u2014 ${formatTime(step.totalTime)} (${step.totalTimePercent.toFixed(1)}%)`,
		);
	}
	return lines.join("\n");
}

function renderPatterns(result: AnalysisResult): string {
	if (result.patterns.length === 0) return "";

	const lines: string[] = [];
	lines.push(chalk.bold("Detected Patterns"));
	lines.push("");

	for (const p of result.patterns) {
		lines.push(`  ${formatSeverity(p.severity)}  ${chalk.bold(p.title)}`);
		lines.push(`    ${p.description}`);
		lines.push(`    Impact: ${formatTime(p.impact)}`);
		if (p.estimatedSavings && p.estimatedSavings > 0) {
			lines.push(
				`    Estimated savings: ${chalk.green(formatTime(p.estimatedSavings))}`,
			);
		}
		if (p.suggestion) {
			lines.push(`    ${chalk.cyan("Suggestion:")} ${p.suggestion}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function renderAppBreakdown(result: AnalysisResult): string {
	if (result.appBreakdown.length === 0) return "";

	const lines: string[] = [];
	lines.push(chalk.bold("App Breakdown"));
	lines.push("");

	for (const app of result.appBreakdown) {
		const pct = app.selfTimePercent.toFixed(1);
		lines.push(
			`  ${bar(app.selfTimePercent)} ${pct.padStart(5)}%  ${formatTime(app.selfTime).padStart(8)}  ${app.appName}`,
		);
	}
	return lines.join("\n");
}

function renderTableBreakdown(result: AnalysisResult): string {
	if (!result.tableBreakdown || result.tableBreakdown.length === 0) return "";

	const lines: string[] = [];
	lines.push(chalk.bold("Table Breakdown"));

	const tableBreakdownTable = new Table({
		head: [
			chalk.gray("Table"),
			chalk.gray("Self Time"),
			chalk.gray("Top Operation"),
			chalk.gray("Call Sites"),
			chalk.gray("SetLoadFields"),
			chalk.gray("Filtered"),
		],
		style: { head: [], border: [] },
	});

	for (const t of result.tableBreakdown) {
		const topOp =
			t.operationBreakdown.length > 0
				? `${t.operationBreakdown[0].operation} (${formatTime(t.operationBreakdown[0].selfTime)})`
				: "-";
		tableBreakdownTable.push([
			t.tableName,
			`${formatTime(t.totalSelfTime)} (${t.totalSelfTimePercent.toFixed(1)}%)`,
			topOp,
			String(t.callSiteCount),
			t.hasSetLoadFields ? chalk.green("Yes") : chalk.gray("No"),
			t.hasFilters ? chalk.green("Yes") : chalk.gray("No"),
		]);
	}

	lines.push(tableBreakdownTable.toString());
	return lines.join("\n");
}

function renderObjectBreakdown(result: AnalysisResult): string {
	if (result.objectBreakdown.length === 0) return "";

	const lines: string[] = [];
	lines.push(chalk.bold("Object Breakdown"));

	const objTable = new Table({
		head: [
			chalk.gray("Object"),
			chalk.gray("ID"),
			chalk.gray("App"),
			chalk.gray("Self Time"),
			chalk.gray("Methods"),
		],
		style: { head: [], border: [] },
	});

	for (const obj of result.objectBreakdown) {
		objTable.push([
			`${obj.objectType} ${obj.objectName}`,
			String(obj.objectId),
			obj.appName,
			`${formatTime(obj.selfTime)} (${obj.selfTimePercent.toFixed(1)}%)`,
			String(obj.methodCount),
		]);
		for (const m of obj.methods) {
			objTable.push([
				chalk.gray(`  ${m.functionName}`),
				"",
				"",
				chalk.gray(
					`${formatTime(m.selfTime)} (${m.selfTimePercent.toFixed(1)}%)`,
				),
				chalk.gray(String(m.hitCount) + " hits"),
			]);
		}
	}

	lines.push(objTable.toString());
	return lines.join("\n");
}

function renderExplanation(result: AnalysisResult): string {
	if (!result.explanation) return "";

	const lines: string[] = [];
	lines.push(chalk.bold("AI Analysis"));
	lines.push(`  ${result.explanation.split("\n").join("\n  ")}`);
	return lines.join("\n");
}

function renderAiNarrative(result: AnalysisResult): string {
	if (!result.aiNarrative) return "";

	const lines: string[] = [];
	lines.push(chalk.bold("AI Narrative"));
	lines.push(`  ${result.aiNarrative.split("\n").join("\n  ")}`);
	return lines.join("\n");
}

function renderAiFindings(result: AnalysisResult): string {
	if (!result.aiFindings || result.aiFindings.length === 0) return "";

	const lines: string[] = [];
	lines.push(chalk.bold("AI Findings"));
	lines.push("");

	for (const f of result.aiFindings) {
		lines.push(
			`  ${formatSeverity(f.severity)}  ${chalk.bold(f.title)}  [${f.confidence} confidence]`,
		);
		lines.push(`    Category: ${f.category}`);
		lines.push(`    ${f.description}`);
		lines.push(`    ${chalk.cyan("Suggestion:")} ${f.suggestion}`);
		lines.push(`    Evidence: ${f.evidence}`);
		if (f.codeFix) {
			lines.push(`    Code fix:`);
			for (const line of f.codeFix.split("\n")) {
				lines.push(`      ${line}`);
			}
		}
		lines.push("");
	}

	return lines.join("\n");
}

const terminalSections: SectionRenderers<string> = {
	summary: renderSummary,
	hotspots: renderHotspots,
	fusion: renderFusion,
	criticalPath: renderCriticalPath,
	patterns: renderPatterns,
	appBreakdown: renderAppBreakdown,
	tableBreakdown: renderTableBreakdown,
	objectBreakdown: renderObjectBreakdown,
	explanation: renderExplanation,
	aiNarrative: renderAiNarrative,
	aiFindings: renderAiFindings,
};

/**
 * Format a single analysis result for terminal display.
 */
export function formatAnalysisTerminal(result: AnalysisResult): string {
	const lines: string[] = [];

	// Header (formatter chrome, not a section)
	lines.push("");
	lines.push(
		chalk.bold.cyan(
			`\u2500\u2500 AL Profile Analysis \u2014 ${result.meta.profilePath} \u2500\u2500`,
		),
	);
	lines.push("");

	for (const section of SECTION_ORDER) {
		const rendered = terminalSections[section](result);
		if (rendered) {
			lines.push(rendered);
			lines.push("");
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Regression-fusion render helpers (P4.1) — terminal
// ---------------------------------------------------------------------------

/**
 * Render a single DiffDeltaSummary line for a regression annotation (terminal).
 * Format: [category] kind (strength) on resourceId — renamed from X — (ambiguous)
 * NEVER says "caused by" (PR2-2 honesty).
 */
function renderDeltaSummaryTerminal(d: DiffDeltaSummary): string {
	const resource = d.resourceId
		? ` on ${d.resourceId}${d.resourceKind ? ` (${d.resourceKind})` : ""}`
		: d.resourceKind
			? ` (${d.resourceKind})`
			: "";
	const op = d.op ? ` [${d.op}]` : "";
	const renamed = d.oldOriginalStableId
		? chalk.gray(` — renamed from ${d.oldOriginalStableId}`)
		: "";
	const ambig = d.ambiguous
		? chalk.yellow(" (ambiguous — multiple routines share this signature)")
		: "";
	return (
		chalk.cyan(`    [${d.category}] ${d.kind}${resource}${op}`) +
		chalk.gray(` (${d.strength})`) +
		renamed +
		ambig
	);
}

/**
 * Render all annotations for an AnnotatedRegression inline under the regression row.
 * Returns "" when fusion absent.
 */
function renderAnnotatedRegressionTerminal(ar: AnnotatedRegression): string {
	const lines: string[] = [];
	if (ar.status === "correlated" || ar.status === "weakly-correlated") {
		for (const d of ar.staticDeltas) {
			if (ar.status === "weakly-correlated") {
				// Muted render for weak-only correlations (PR2-2).
				const resource = d.resourceId ? ` on ${d.resourceId}` : "";
				const renamed = d.oldOriginalStableId
					? ` — renamed from ${d.oldOriginalStableId}`
					: "";
				lines.push(
					chalk.gray(
						`    ↳ (runtime-neutral capability — unlikely to explain the regression: [${d.category}] ${d.kind}${resource}${renamed})`,
					),
				);
			} else {
				lines.push(`    ↳ ${renderDeltaSummaryTerminal(d)}`);
			}
		}
	} else {
		// unexplained-static (PR2-2 honest wording)
		lines.push(
			chalk.gray(
				"    ↳ no static change in this routine — cause is runtime/data/config or a callee; al-sem cannot explain it",
			),
		);
	}
	return lines.join("\n");
}

/**
 * Render the after-side single-snapshot fusion views in a comparison context
 * (PR2-6 after-only fallback, P4.2). Returns "" when absent (byte-unchanged).
 */
function renderAfterFusionTerminal(fv: FusionViews | undefined): string {
	if (!fv || fv.prioritizedFindings.length === 0) return "";

	const lines: string[] = [
		chalk.bold("After-Side Static Findings (single-snapshot fusion)"),
	];
	const table = new Table({
		head: ["#", "Finding", "Detector", "Routine", "Self%", "Total%", "Sev"].map(
			(h) => chalk.gray(h),
		),
		style: { head: [], border: [] },
	});

	fv.prioritizedFindings.forEach((p, i) => {
		const orch = p.efficiencyScore < 0.5 ? chalk.gray(" (orchestrator)") : "";
		table.push([
			String(i + 1),
			renderFusionFindingTitle(p),
			p.finding.detector,
			`${p.functionName}${orch}`,
			p.selfTimePercent.toFixed(1),
			p.totalTimePercent.toFixed(1),
			p.finding.severity,
		]);
	});

	lines.push(table.toString());

	fv.prioritizedFindings.forEach((p, i) => {
		const chain = renderCausalChain(p.causalSteps);
		if (chain) {
			lines.push(chalk.gray(`  Finding #${i + 1} causal chain:`));
			lines.push(chain);
		}
	});

	return lines.join("\n");
}

/**
 * Render the full regression-fusion block for terminal output (P4.1).
 * Returns "" when regressionFusion is absent (byte-unchanged).
 */
function renderRegressionFusionTerminal(
	fusion: RegressionFusion | undefined,
): string {
	if (!fusion) return "";

	const lines: string[] = [];

	// 1. Version-mismatch warning — rendered PROMINENTLY at the top (PR2-4).
	if (fusion.correlationSummary.versionMismatch) {
		const vm = fusion.correlationSummary.versionMismatch;
		const beforeMsg =
			vm.beforeProfileVersion && vm.beforeWorkspaceVersion
				? `before profile ${vm.beforeProfileVersion} ≠ source ${vm.beforeWorkspaceVersion}`
				: "";
		const afterMsg =
			vm.afterProfileVersion && vm.afterWorkspaceVersion
				? `after profile ${vm.afterProfileVersion} ≠ source ${vm.afterWorkspaceVersion}`
				: "";
		const detail = [beforeMsg, afterMsg].filter(Boolean).join("; ");
		lines.push(
			chalk.yellow(
				`⚠ profile version ≠ source version${detail ? `: ${detail}` : ""}; correlations may be inaccurate`,
			),
		);
		lines.push("");
	}

	// 2. Annotated regressions section.
	if (fusion.annotatedRegressions.length > 0) {
		lines.push(chalk.bold("Regression-Fusion Annotations"));
		const cs = fusion.correlationSummary;
		lines.push(
			chalk.gray(
				`  correlated: ${cs.correlated} | weakly-correlated: ${cs.weaklyCorrelated} | unexplained: ${cs.unexplained}`,
			),
		);
		lines.push("");
		for (const ar of fusion.annotatedRegressions) {
			const statusLabel =
				ar.status === "correlated"
					? chalk.cyan("[correlated]")
					: ar.status === "weakly-correlated"
						? chalk.gray("[weakly-correlated]")
						: chalk.gray("[unexplained-static]");
			lines.push(
				`  ${statusLabel} ${ar.method.functionName} (${ar.method.objectType} ${ar.method.objectId})`,
			);
			const annotation = renderAnnotatedRegressionTerminal(ar);
			if (annotation) lines.push(annotation);
		}
		lines.push("");
	}

	// 3. New/removed hot methods (PR2-5 headline).
	const renderMethodMatch = (m: MethodMatch, action: string): string => {
		const delta = m.delta;
		const resource = delta.resourceId ? ` on ${delta.resourceId}` : "";
		const renamed = delta.oldOriginalStableId
			? ` — renamed from ${delta.oldOriginalStableId}`
			: "";
		const ambig = delta.ambiguous ? " (ambiguous)" : "";
		return `  ${chalk.green("+")} ${action} ${chalk.white.bold(m.method.functionName)} (${m.method.objectType} ${m.method.objectId}) — [${delta.category}] ${delta.kind}${resource}${renamed}${ambig}`;
	};

	if (
		fusion.newMethodCorrelations.length > 0 ||
		fusion.removedMethodCorrelations.length > 0
	) {
		lines.push(chalk.bold("New / Removed Hot Methods"));
		for (const m of fusion.newMethodCorrelations) {
			lines.push(renderMethodMatch(m, "new hot method"));
		}
		for (const m of fusion.removedMethodCorrelations) {
			lines.push(
				`  ${chalk.red("-")} removed hot method ${chalk.white.bold(m.method.functionName)} (${m.method.objectType} ${m.method.objectId}) — [${m.delta.category}] ${m.delta.kind}`,
			);
		}
		lines.push("");
	}

	// 4. Static-only changes summary (cross-boundary event deltas noted).
	if (fusion.staticOnlyChanges.length > 0) {
		lines.push(chalk.bold("Static-Only Changes"));
		lines.push(
			chalk.gray(
				"  (no matching runtime regression — may be cost-neutral or externalized)",
			),
		);
		for (const d of fusion.staticOnlyChanges) {
			const resource = d.resourceId ? ` on ${d.resourceId}` : "";
			const crossBoundary =
				d.basis === "none"
					? chalk.gray(" — externalized cost, see subscribers")
					: "";
			const renamed = d.oldOriginalStableId
				? chalk.gray(` — renamed from ${d.oldOriginalStableId}`)
				: "";
			lines.push(
				`  ${chalk.gray(`[${d.category}] ${d.kind}${resource}`)} ${chalk.gray(`(${d.strength})`)}${crossBoundary}${renamed} — ${d.displayName}`,
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Format a comparison result for terminal display.
 */
export function formatComparisonTerminal(result: ComparisonResult): string {
	const lines: string[] = [];

	// 1. Header
	lines.push("");
	lines.push(
		chalk.bold.cyan("\u2500\u2500 AL Profile Comparison \u2500\u2500"),
	);
	lines.push("");
	lines.push(`  Before: ${result.meta.beforePath} (${result.meta.beforeType})`);
	lines.push(`  After:  ${result.meta.afterPath} (${result.meta.afterType})`);
	lines.push("");

	// 2. Delta summary
	const deltaSign = result.summary.deltaTime >= 0 ? "+" : "";
	const direction =
		result.summary.deltaTime > 0
			? chalk.red("SLOWER")
			: result.summary.deltaTime < 0
				? chalk.green("FASTER")
				: chalk.gray("UNCHANGED");

	lines.push(chalk.bold("Delta Summary"));
	lines.push(
		`  ${direction}  ${deltaSign}${formatTime(result.summary.deltaTime)} (${deltaSign}${result.summary.deltaPercent.toFixed(1)}%)`,
	);
	lines.push(`  Before total: ${formatTime(result.summary.beforeTotalTime)}`);
	lines.push(`  After total:  ${formatTime(result.summary.afterTotalTime)}`);
	lines.push("");

	// 3. Regressions
	if (result.regressions.length > 0) {
		lines.push(chalk.bold.red("Regressions"));

		const regTable = new Table({
			head: [
				chalk.gray(""),
				chalk.gray("Function"),
				chalk.gray("Object"),
				chalk.gray("Before"),
				chalk.gray("After"),
				chalk.gray("Delta"),
			],
			style: { head: [], border: [] },
		});

		for (const r of result.regressions) {
			regTable.push([
				chalk.red("\u2191"),
				r.functionName,
				`${r.objectType} ${r.objectId}`,
				formatTime(r.beforeSelfTime),
				formatTime(r.afterSelfTime),
				chalk.red(
					`+${formatTime(r.deltaSelfTime)} (+${r.deltaPercent.toFixed(1)}%)`,
				),
			]);
		}

		lines.push(regTable.toString());
		lines.push("");
	}

	// 4. Improvements
	if (result.improvements.length > 0) {
		lines.push(chalk.bold.green("Improvements"));

		const impTable = new Table({
			head: [
				chalk.gray(""),
				chalk.gray("Function"),
				chalk.gray("Object"),
				chalk.gray("Before"),
				chalk.gray("After"),
				chalk.gray("Delta"),
			],
			style: { head: [], border: [] },
		});

		for (const imp of result.improvements) {
			impTable.push([
				chalk.green("\u2193"),
				imp.functionName,
				`${imp.objectType} ${imp.objectId}`,
				formatTime(imp.beforeSelfTime),
				formatTime(imp.afterSelfTime),
				chalk.green(
					`${formatTime(imp.deltaSelfTime)} (${imp.deltaPercent.toFixed(1)}%)`,
				),
			]);
		}

		lines.push(impTable.toString());
		lines.push("");
	}

	// 5. New methods
	if (result.newMethods.length > 0) {
		lines.push(chalk.bold("New Methods"));
		for (const m of result.newMethods) {
			lines.push(
				`  ${chalk.green("+")} ${m.functionName} (${m.objectType} ${m.objectId}) \u2014 ${formatTime(m.selfTime)}`,
			);
		}
		lines.push("");
	}

	// 6. Removed methods
	if (result.removedMethods.length > 0) {
		lines.push(chalk.bold("Removed Methods"));
		for (const m of result.removedMethods) {
			lines.push(
				`  ${chalk.red("-")} ${m.functionName} (${m.objectType} ${m.objectId}) \u2014 ${formatTime(m.selfTime)}`,
			);
		}
		lines.push("");
	}

	// 7. Pattern Deltas
	if (result.patternDeltas && result.patternDeltas.length > 0) {
		lines.push(chalk.bold("Pattern Changes"));
		lines.push("");
		for (const d of result.patternDeltas) {
			const icon =
				d.status === "new"
					? chalk.red("+ NEW")
					: d.status === "resolved"
						? chalk.green("- RESOLVED")
						: chalk.yellow("~ CHANGED");
			const severityStr =
				d.status === "changed"
					? `${d.beforeSeverity} \u2192 ${d.severity}`
					: d.severity;
			lines.push(
				`  ${icon}  [${severityStr}] ${d.title} (${formatTime(d.impact)})`,
			);
		}
		lines.push("");
	}

	// 8. Regression-fusion annotations (P4.1 \u2014 absent when no sources supplied).
	const fusionBlock = renderRegressionFusionTerminal(result.regressionFusion);
	if (fusionBlock) {
		lines.push(fusionBlock);
	}

	// 9. After-side single-snapshot fusion (PR2-6 after-only fallback, P4.2).
	const afterFusionBlock = renderAfterFusionTerminal(result.afterFusionViews);
	if (afterFusionBlock) {
		lines.push(afterFusionBlock);
	}

	return lines.join("\n");
}
