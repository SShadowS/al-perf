import { marked } from "marked";
import { formatTime } from "../../core/analyzer.js";
import { truncateFunctionName } from "../../core/display-utils.js";
import type { SectionRenderers } from "../../output/sections.js";
import { SECTION_ORDER } from "../../output/sections.js";
import type { AnalysisResult } from "../../output/types.js";
import {
	type CausalStep,
	formatOriginatingObjectNote,
	type HotspotAnnotation,
	type PrioritizedFinding,
} from "../../semantic/views.js";
import type { MethodBreakdown } from "../../types/aggregated.js";

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(str: string | undefined | null): string {
	if (!str) return "";
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Build the "runtime-correlated" badge HTML for a list of pattern ids.
 * Returns "" when patterns is absent or empty (byte-unchanged off).
 * Badge text is ALWAYS "runtime-correlated" — NEVER "runtime-confirmed" (R3-6).
 */
function runtimeCorrelatedBadgeHtml(patterns: string[] | undefined): string {
	if (!patterns || patterns.length === 0) return "";
	return ` <span style="color:#00B7C3;font-weight:600">⚡ runtime-correlated (${escapeHtml(patterns.join(", "))})</span>`;
}

/**
 * Map severity to BC-themed color.
 */
function severityColor(severity: "critical" | "warning" | "info"): string {
	switch (severity) {
		case "critical":
			return "#EB6965";
		case "warning":
			return "#9F9700";
		case "info":
			return "#505C6D";
	}
}

function renderSummary(result: AnalysisResult): string {
	const pc = result.summary.patternCount;
	const source = result.meta.sourceAvailable ? "source available" : "no source";
	const samplingRow =
		result.meta.samplingInterval !== undefined
			? `<tr><td>Sampling Interval</td><td>${formatTime(result.meta.samplingInterval)}</td></tr>`
			: "";

	return `<p class="summary-text">${escapeHtml(result.summary.oneLiner)}</p>
  <div class="badges">
    <span class="badge" style="background:#EB6965">${pc.critical} Critical</span>
    <span class="badge" style="background:#9F9700">${pc.warning} Warning</span>
    <span class="badge" style="background:#505C6D">${pc.info} Info</span>
  </div>

  <div class="section">
    <h2>Profile Details</h2>
    <table class="meta-table">
      <tr><td>Type</td><td>${escapeHtml(result.meta.profileType)}</td></tr>
      <tr><td>Nodes</td><td>${result.meta.totalNodes}</td></tr>
      <tr><td>Max Depth</td><td>${result.meta.maxDepth}</td></tr>
      <tr><td>Source</td><td>${source}</td></tr>
      ${samplingRow}
      ${
				result.meta.builtinSelfTime !== undefined &&
				result.meta.builtinSelfTime > 0
					? `<tr><td>Built-in Overhead</td><td>${formatTime(result.meta.builtinSelfTime)}</td></tr>`
					: ""
			}
      <tr><td>Confidence</td><td>${result.meta.confidenceScore}/100</td></tr>
      <tr><td>Health</td><td>${result.summary.healthScore}/100</td></tr>
    </table>
  </div>`;
}

/**
 * Build the per-hotspot static-cause annotation HTML (R2-4, R2-9/R2-10).
 * Returns "" when annotation is absent. Never mutates result.hotspots[i] (R2-5).
 */
function fusionAnnotationHtml(
	annotation: HotspotAnnotation | undefined,
): string {
	if (!annotation) return "";
	if (annotation.status === "blind-spot") {
		const reason = annotation.reason
			? ` (${escapeHtml(annotation.reason)})`
			: "";
		return `<tr class="fusion-annotation"><td colspan="8" style="color:#505C6D;font-size:0.85em;padding-left:24px">\u21b3 not statically analyzed${reason}</td></tr>`;
	}
	if (annotation.status === "ambiguous") {
		return `<tr class="fusion-annotation"><td colspan="8" style="color:#9F9700;font-size:0.85em;padding-left:24px">\u21b3 ${annotation.findings.length} possible static cause(s) (ambiguous)</td></tr>`;
	}
	// matched
	const badge = runtimeCorrelatedBadgeHtml(annotation.corroboratingPatterns);
	const provenanceNote = escapeHtml(formatOriginatingObjectNote(annotation));
	if (annotation.findings.length === 0) {
		// R2-9: never imply clean unless matchedClean === true
		if (annotation.matchedClean === true) {
			return `<tr class="fusion-annotation"><td colspan="8" style="color:#00B7C3;font-size:0.85em;padding-left:24px">\u21b3 analyzed, no static findings${provenanceNote}${badge}</td></tr>`;
		}
		const reason = escapeHtml(annotation.reason ?? "coverage incomplete");
		return `<tr class="fusion-annotation"><td colspan="8" style="color:#505C6D;font-size:0.85em;padding-left:24px">\u21b3 matched; ${reason}${provenanceNote}${badge}</td></tr>`;
	}
	// Render all finding rows; append the badge to the last finding row inline
	const rows = annotation.findings.map(
		(f) =>
			`\u21b3 [${escapeHtml(f.detector)}] ${escapeHtml(f.title)} @ ${escapeHtml(f.primaryLocation.file)}:${f.primaryLocation.line} (${escapeHtml(f.severity)}/${escapeHtml(f.confidence.level)})${provenanceNote}`,
	);
	if (badge && rows.length > 0) {
		rows[rows.length - 1] += badge;
	}
	return rows
		.map(
			(text) =>
				`<tr class="fusion-annotation"><td colspan="8" style="color:#00B7C3;font-size:0.85em;padding-left:24px">${text}</td></tr>`,
		)
		.join("\n");
}

function renderHotspots(result: AnalysisResult): string {
	if (result.hotspots.length === 0) return "";

	// Build annotation lookup when fusionViews is present (R2-5: never mutate hotspots[i])
	const annMap: Map<string, HotspotAnnotation> = result.fusionViews
		? new Map(result.fusionViews.hotspotAnnotations.map((a) => [a.attrKey, a]))
		: new Map();

	const rows = result.hotspots
		.map((h: MethodBreakdown, i: number) => {
			const gapStr =
				h.gapTime && h.gapTime > 0
					? ` <span style="color:#9F9700">+${formatTime(h.gapTime)} wait</span>`
					: "";
			const objectStr = h.sourceLocation
				? `${escapeHtml(h.objectType)} ${h.objectId}<br><span style="color:#505C6D;font-size:0.85em">${escapeHtml(h.sourceLocation.filePath)}:${h.sourceLocation.lineStart}</span>`
				: `${escapeHtml(h.objectType)} ${h.objectId} (${escapeHtml(h.objectName)})`;
			const calledByStr =
				h.calledBy.length > 0
					? escapeHtml(h.calledBy.slice(0, 3).join(", "))
					: "\u2014";
			const displayName = truncateFunctionName(h.functionName);
			const nameHtml =
				displayName !== h.functionName
					? `<strong title="${escapeHtml(h.functionName)}">${escapeHtml(displayName)}</strong>`
					: `<strong>${escapeHtml(h.functionName)}</strong>`;
			const mainRow = `<tr>
        <td>${i + 1}</td>
        <td>${nameHtml}</td>
        <td>${objectStr}</td>
        <td>${escapeHtml(h.appName)}</td>
        <td>${formatTime(h.selfTime)} (${h.selfTimePercent.toFixed(1)}%)${gapStr}</td>
        <td>${formatTime(h.totalTime)} (${h.totalTimePercent.toFixed(1)}%)</td>
        <td>${h.hitCount}</td>
        <td style="font-size:0.85em">${calledByStr}</td>
      </tr>`;
			// Append annotation row when fusionViews present
			const key = `${h.functionName}_${h.objectType}_${h.objectId}`;
			const annRow = result.fusionViews
				? fusionAnnotationHtml(annMap.get(key))
				: "";
			return annRow ? mainRow + "\n" + annRow : mainRow;
		})
		.join("\n");

	return `<div class="section">
    <h2>Top Hotspots</h2>
    <table>
      <thead>
        <tr><th>#</th><th>Function</th><th>Object</th><th>App</th><th>Self Time</th><th>Total Time</th><th>Hits</th><th>Called By</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function renderFusionFindingCell(p: PrioritizedFinding): string {
	const amb =
		p.frameCount > 1
			? ` <span style="color:#9F9700">(\u00d7${p.frameCount} ambiguous)</span>`
			: "";
	const badge = runtimeCorrelatedBadgeHtml(p.corroboratingPatterns);
	return `${escapeHtml(p.finding.title)}${amb}${badge}`;
}

/**
 * Render a collapsible causal chain for a prioritized finding (P3.2b).
 * Returns "" when causalSteps is absent or empty (byte-unchanged off).
 * Uses a <details>/<summary> for collapsibility. All dynamic text is HTML-escaped.
 */
function renderCausalChainHtml(
	steps: CausalStep[] | undefined,
	findingIdx: number,
): string {
	if (!steps || steps.length === 0) return "";
	const rows = steps
		.map((s) => {
			const loc = `${escapeHtml(s.file)}:${s.line}`;
			const hotMark = s.isHot
				? `<span style="color:#FFB900;font-weight:600">\u26a1 </span>`
				: "";
			if (s.routineName !== undefined) {
				const pct =
					s.selfTimePercent !== undefined && s.totalTimePercent !== undefined
						? ` <span style="color:#505C6D">(${s.selfTimePercent.toFixed(1)}%/${s.totalTimePercent.toFixed(1)}%)</span>`
						: "";
				return `<div style="margin:2px 0;padding-left:8px">\u21b3 ${hotMark}${escapeHtml(s.note)} @ <code>${escapeHtml(s.routineName)}</code>${pct} <span style="color:#505C6D;font-size:0.85em">[${loc}]</span></div>`;
			}
			return `<div style="margin:2px 0;padding-left:8px">\u21b3 ${hotMark}${escapeHtml(s.note)} <span style="color:#505C6D;font-size:0.85em">[${loc}]</span></div>`;
		})
		.join("\n");
	return `<details style="margin:4px 0 4px 8px;font-size:0.88em">
      <summary style="cursor:pointer;color:#505C6D">Causal chain (finding #${findingIdx + 1})</summary>
      <div style="font-family:monospace;padding:4px 0">
        ${rows}
      </div>
    </details>`;
}

function renderFusion(result: AnalysisResult): string {
	const fv = result.fusionViews;
	if (!fv || fv.prioritizedFindings.length === 0) return "";

	const rows = fv.prioritizedFindings
		.map((p, i) => {
			const orch =
				p.efficiencyScore < 0.5
					? ` <span style="color:#505C6D">(orchestrator)</span>`
					: "";
			return `<tr>
        <td>${i + 1}</td>
        <td>${renderFusionFindingCell(p)}</td>
        <td>${escapeHtml(p.finding.detector)}</td>
        <td style="font-family:monospace">${escapeHtml(p.functionName)}${orch}</td>
        <td>${p.selfTimePercent.toFixed(1)}</td>
        <td>${p.totalTimePercent.toFixed(1)}</td>
        <td>${escapeHtml(p.finding.severity)}</td>
      </tr>`;
		})
		.join("\n");

	// P3.2b: render causal chains (collapsible) after the table (gated on causalSteps).
	const chains = fv.prioritizedFindings
		.map((p, i) => renderCausalChainHtml(p.causalSteps, i))
		.filter((h) => h.length > 0)
		.join("\n");

	return `<div class="section">
    <h2>Runtime-Prioritized Static Findings</h2>
    <table>
      <thead>
        <tr><th>#</th><th>Finding</th><th>Detector</th><th>Routine</th><th>Self%</th><th>Total%</th><th>Severity</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    ${chains}
  </div>`;
}

function renderCriticalPath(result: AnalysisResult): string {
	if (!result.criticalPath || result.criticalPath.length <= 1) return "";

	return `<div class="section">
    <h2>Critical Path</h2>
    <div style="font-family:monospace;font-size:0.95em">
      ${result.criticalPath
				.map((step) => {
					const indent = "\u00A0\u00A0\u00A0\u00A0".repeat(step.depth);
					const arrow = step.depth > 0 ? "\u2514\u2500 " : "";
					return `<div style="margin:2px 0">${indent}${arrow}<strong>${escapeHtml(step.functionName)}</strong> (${escapeHtml(step.objectType)} ${step.objectId}) \u2014 ${formatTime(step.totalTime)} (${step.totalTimePercent.toFixed(1)}%)</div>`;
				})
				.join("\n")}
    </div>
  </div>`;
}

function renderPatterns(result: AnalysisResult): string {
	if (result.patterns.length === 0) return "";

	const patternsHtml = result.patterns
		.map((p) => {
			const color = severityColor(p.severity);
			const suggestion = p.suggestion
				? `<p class="suggestion"><strong>Suggestion:</strong> ${escapeHtml(p.suggestion)}</p>`
				: "";
			return `<div class="pattern">
        <div class="pattern-header">
          <span class="severity-badge" style="background:${color}">${p.severity.toUpperCase()}</span>
          <span class="pattern-title">${escapeHtml(p.title)}</span>
        </div>
        <p>${escapeHtml(p.description)}</p>
        <p class="impact"><strong>Impact:</strong> ${formatTime(p.impact)}</p>
        ${suggestion}
      </div>`;
		})
		.join("\n");

	return `<div class="section">
    <h2>Detected Patterns</h2>
    ${patternsHtml}
  </div>`;
}

function renderAppBreakdown(result: AnalysisResult): string {
	if (result.appBreakdown.length === 0) return "";

	const rows = result.appBreakdown
		.map((app) => {
			const pct = app.selfTimePercent.toFixed(1);
			const barWidth = Math.round(app.selfTimePercent);
			return `<tr>
        <td>${escapeHtml(app.appName)}</td>
        <td>${formatTime(app.selfTime)}</td>
        <td>${pct}%</td>
        <td><div class="bar" style="width:${barWidth}%"></div></td>
      </tr>`;
		})
		.join("\n");

	return `<div class="section">
    <h2>App Breakdown</h2>
    <table>
      <thead>
        <tr><th>App</th><th>Self Time</th><th>%</th><th>Chart</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function renderTableBreakdown(result: AnalysisResult): string {
	if (!result.tableBreakdown || result.tableBreakdown.length === 0) return "";

	const rows = result.tableBreakdown
		.map((t) => {
			const topOp =
				t.operationBreakdown.length > 0
					? `${escapeHtml(t.operationBreakdown[0].operation)} (${formatTime(t.operationBreakdown[0].selfTime)})`
					: "\u2014";
			return `<tr>
            <td>${escapeHtml(t.tableName)}</td>
            <td>${formatTime(t.totalSelfTime)} (${t.totalSelfTimePercent.toFixed(1)}%)</td>
            <td>${topOp}</td>
            <td>${t.callSiteCount}</td>
            <td>${t.hasSetLoadFields ? "Yes" : "No"}</td>
            <td>${t.hasFilters ? "Yes" : "No"}</td>
          </tr>`;
		})
		.join("\n");

	return `<div class="section">
    <h2>Table Breakdown</h2>
    <table>
      <thead>
        <tr><th>Table</th><th>Self Time</th><th>Top Operation</th><th>Call Sites</th><th>SetLoadFields</th><th>Filtered</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function renderObjectBreakdown(result: AnalysisResult): string {
	if (result.objectBreakdown.length === 0) return "";

	const rows = result.objectBreakdown
		.map((obj) => {
			const headerRow = `<tr style="font-weight:600">
            <td>${escapeHtml(obj.objectType)} ${escapeHtml(obj.objectName)}</td>
            <td>${obj.objectId}</td>
            <td>${escapeHtml(obj.appName)}</td>
            <td>${formatTime(obj.selfTime)} (${obj.selfTimePercent.toFixed(1)}%)</td>
            <td>${obj.methodCount}</td>
          </tr>`;
			const methodRows = obj.methods
				.map(
					(m) =>
						`<tr>
              <td style="padding-left:24px;color:#505C6D">${escapeHtml(m.functionName)}</td>
              <td></td>
              <td></td>
              <td style="color:#505C6D">${formatTime(m.selfTime)} (${m.selfTimePercent.toFixed(1)}%)</td>
              <td style="color:#505C6D">${m.hitCount} hits</td>
            </tr>`,
				)
				.join("\n");
			return headerRow + "\n" + methodRows;
		})
		.join("\n");

	return `<div class="section">
    <h2>Object Breakdown</h2>
    <table>
      <thead>
        <tr><th>Object</th><th>ID</th><th>App</th><th>Self Time</th><th>Methods</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function renderExplanation(result: AnalysisResult): string {
	if (!result.explanation) return "";

	const explanationHtml = marked.parse(
		result.explanation.replace(/<[^>]*>/g, ""),
	);
	return `<div class="section explanation">${explanationHtml}</div>`;
}

function renderAiNarrative(result: AnalysisResult): string {
	if (!result.aiNarrative) return "";

	const narrativeHtml = marked.parse(
		result.aiNarrative.replace(/<[^>]*>/g, ""),
	);
	return `<div class="section explanation">
    <h2>AI Narrative</h2>
    ${narrativeHtml}
  </div>`;
}

function renderAiFindings(result: AnalysisResult): string {
	if (!result.aiFindings || result.aiFindings.length === 0) return "";

	const findingsHtml = result.aiFindings
		.map((f) => {
			const color = severityColor(f.severity);
			const codeFixHtml = f.codeFix
				? `<pre><code class="language-al">${escapeHtml(f.codeFix)}</code></pre>`
				: "";
			return `<div class="pattern">
        <div class="pattern-header">
          <span class="severity-badge" style="background:${color}">${f.severity.toUpperCase()}</span>
          <span class="pattern-title">${escapeHtml(f.title)}</span>
          <span style="color:#505C6D;font-size:0.85em">[${f.confidence} confidence]</span>
        </div>
        <p style="color:#505C6D;font-size:0.85em">Category: ${escapeHtml(f.category)}</p>
        <p>${escapeHtml(f.description)}</p>
        <p class="suggestion"><strong>Suggestion:</strong> ${escapeHtml(f.suggestion)}</p>
        <p class="impact"><strong>Evidence:</strong> ${escapeHtml(f.evidence)}</p>
        ${codeFixHtml}
      </div>`;
		})
		.join("\n");

	return `<div class="section">
    <h2>AI Findings</h2>
    ${findingsHtml}
  </div>`;
}

const htmlSections: SectionRenderers<string> = {
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
 * Format a single analysis result as a self-contained BC-themed HTML page.
 */
export function formatAnalysisHtml(result: AnalysisResult): string {
	const sectionHtml = SECTION_ORDER.map((section) =>
		htmlSections[section](result),
	)
		.filter((html) => html !== "")
		.join("\n\n  ");

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AL Profile Analysis</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Segoe UI", sans-serif;
      font-size: 13.5pt;
      color: #212121;
      background: #FFFFFF;
      padding: 24px;
      line-height: 1.5;
    }
    h1 { color: #00B7C3; margin-bottom: 16px; font-size: 1.5em; }
    h2 { color: #00B7C3; margin: 24px 0 12px; font-size: 1.2em; border-bottom: 2px solid #00B7C3; padding-bottom: 4px; }
    .section { margin-bottom: 24px; }
    .summary-text { margin-bottom: 12px; }
    .badges { display: flex; gap: 12px; margin: 12px 0; }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 4px;
      color: #fff;
      font-weight: 600;
      font-size: 0.9em;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 0.95em;
    }
    th, td {
      text-align: left;
      padding: 6px 10px;
      border-bottom: 1px solid #E0E0E0;
    }
    th { background: #F5F5F5; font-weight: 600; }
    tr:hover { background: #FAFAFA; }
    .pattern {
      border: 1px solid #E0E0E0;
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 12px;
    }
    .pattern-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .severity-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 3px;
      color: #fff;
      font-weight: 700;
      font-size: 0.8em;
      text-transform: uppercase;
    }
    .pattern-title { font-weight: 600; }
    .impact { color: #505C6D; font-size: 0.9em; }
    .suggestion { color: #00B7C3; margin-top: 4px; font-size: 0.9em; }
    .bar { height: 14px; background: #00B7C3; border-radius: 2px; min-width: 2px; }
    .meta-table td:first-child { font-weight: 600; width: 180px; }
    .explanation h2, .explanation h3 { color: #212121; border-bottom: 1px solid #E0E0E0; }
    .explanation h2 { font-size: 1.1em; margin: 20px 0 8px; }
    .explanation h3 { font-size: 1em; margin: 16px 0 6px; }
    .explanation p { margin: 8px 0; }
    .explanation ul, .explanation ol { margin: 8px 0 8px 24px; }
    .explanation li { margin: 4px 0; }
    .explanation blockquote {
      border-left: 3px solid #00B7C3;
      padding: 8px 16px;
      margin: 12px 0;
      background: #F5FAFA;
      color: #505C6D;
    }
    .explanation code {
      background: #F5F5F5;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .explanation pre {
      background: #F5F5F5;
      padding: 12px 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 12px 0;
    }
    .explanation pre code { background: none; padding: 0; }
    .explanation table {
      border: 1px solid #E0E0E0;
      margin: 12px 0;
    }
    .explanation table th { background: #F5F5F5; }
    .explanation hr { border: none; border-top: 1px solid #E0E0E0; margin: 16px 0; }
    .explanation strong { color: #212121; }
  </style>
</head>
<body>
  ${sectionHtml}
</body>
</html>`;
}
