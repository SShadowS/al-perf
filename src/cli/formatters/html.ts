import { marked } from "marked";
import type { AnalysisResult } from "../../output/types.js";
import type { MethodBreakdown } from "../../types/aggregated.js";
import { formatTime } from "../../core/analyzer.js";

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

/**
 * Format a single analysis result as a self-contained BC-themed HTML page.
 * Layout: AI Analysis → Profile Details → Hotspots → Patterns → App Breakdown.
 */
export function formatAnalysisHtml(result: AnalysisResult): string {
  const pc = result.summary.patternCount;

  const hotspotsRows = result.hotspots
    .map((h: MethodBreakdown, i: number) => {
      return `<tr>
        <td>${i + 1}</td>
        <td><strong>${escapeHtml(h.functionName)}</strong></td>
        <td>${escapeHtml(h.objectType)} ${h.objectId} (${escapeHtml(h.objectName)})</td>
        <td>${escapeHtml(h.appName)}</td>
        <td>${formatTime(h.selfTime)} (${h.selfTimePercent.toFixed(1)}%)</td>
        <td>${formatTime(h.totalTime)} (${h.totalTimePercent.toFixed(1)}%)</td>
        <td>${h.hitCount}</td>
      </tr>`;
    })
    .join("\n");

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

  const appRows = result.appBreakdown
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

  const explanationHtml = result.explanation
    ? marked.parse(result.explanation)
    : "";

  const explanationSection = explanationHtml
    ? `<div class="section explanation">${explanationHtml}</div>`
    : "";

  const source = result.meta.sourceAvailable ? "source available" : "no source";
  const samplingRow = result.meta.samplingInterval !== undefined
    ? `<tr><td>Sampling Interval</td><td>${formatTime(result.meta.samplingInterval)}</td></tr>`
    : "";

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
  <p class="summary-text">${escapeHtml(result.summary.oneLiner)}</p>
  <div class="badges">
    <span class="badge" style="background:#EB6965">${pc.critical} Critical</span>
    <span class="badge" style="background:#9F9700">${pc.warning} Warning</span>
    <span class="badge" style="background:#505C6D">${pc.info} Info</span>
  </div>

  ${explanationSection}

  <div class="section">
    <h2>Profile Details</h2>
    <table class="meta-table">
      <tr><td>Type</td><td>${escapeHtml(result.meta.profileType)}</td></tr>
      <tr><td>Nodes</td><td>${result.meta.totalNodes}</td></tr>
      <tr><td>Max Depth</td><td>${result.meta.maxDepth}</td></tr>
      <tr><td>Source</td><td>${source}</td></tr>
      ${samplingRow}
    </table>
  </div>

  ${result.hotspots.length > 0 ? `<div class="section">
    <h2>Top Hotspots</h2>
    <table>
      <thead>
        <tr><th>#</th><th>Function</th><th>Object</th><th>App</th><th>Self Time</th><th>Total Time</th><th>Hits</th></tr>
      </thead>
      <tbody>
        ${hotspotsRows}
      </tbody>
    </table>
  </div>` : ""}

  ${result.patterns.length > 0 ? `<div class="section">
    <h2>Detected Patterns</h2>
    ${patternsHtml}
  </div>` : ""}

  ${result.appBreakdown.length > 0 ? `<div class="section">
    <h2>App Breakdown</h2>
    <table>
      <thead>
        <tr><th>App</th><th>Self Time</th><th>%</th><th>Chart</th></tr>
      </thead>
      <tbody>
        ${appRows}
      </tbody>
    </table>
  </div>` : ""}
</body>
</html>`;
}
