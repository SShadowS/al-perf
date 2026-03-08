/**
 * test-ai-quality.ts — Run AI analysis (explain + deep) across all example profiles
 * and capture debug output for quality review.
 *
 * Usage: bun run scripts/test-ai-quality.ts
 * Requires: ANTHROPIC_API_KEY environment variable
 */

import { analyzeProfile } from "../src/core/analyzer.js";
import { explainAnalysis, type ExplainResult, type ExplainModel } from "../src/explain/explainer.js";
import { deepAnalysis, type DeepExplainResult } from "../src/explain/deep-analyzer.js";
import { findCompanionZip, extractCompanionZip } from "../src/source/zip-extractor.js";
import { writeCaptureToDisk } from "../src/debug/writer.js";
import { initIdCounter, nextId } from "../src/debug/ids.js";
import type { DebugCapture } from "../src/debug/types.js";
import type { ProcessedProfile } from "../src/types/processed.js";
import type { ApiCallCost } from "../src/explain/api-cost.js";
import { formatCallCost } from "../src/explain/api-cost.js";
import { readdir, mkdir, readFile, writeFile as fsWriteFile } from "fs/promises";
import { resolve, basename } from "path";
import { existsSync } from "fs";
import type { AIFinding } from "../src/types/ai-findings.js";

const EXAMPLE_DIR = resolve(import.meta.dir, "..", "exampledata");

function log(msg: string): void {
  process.stderr.write(msg + "\n");
}

async function analyzeOne(
  profilePath: string,
  runDir: string,
  apiKey: string,
  model: ExplainModel,
): Promise<number> {
  const profileName = basename(profilePath);
  log(`\n--- ${profileName} ---`);

  const start = performance.now();

  // Read profile bytes for capture
  const profileData = new Uint8Array(await Bun.file(profilePath).arrayBuffer());

  // Check for companion zip
  const zipPath = findCompanionZip(profilePath);
  let sourceZipData: Uint8Array | undefined;
  let sourcePath: string | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  if (zipPath) {
    log(`  Companion zip found: ${basename(zipPath)}`);
    sourceZipData = new Uint8Array(await Bun.file(zipPath).arrayBuffer());
    const extracted = await extractCompanionZip(zipPath);
    sourcePath = extracted.extractDir;
    cleanup = extracted.cleanup;
    log(`  Extracted ${extracted.alFileCount} AL files`);
  }

  try {
    // Run analysis
    let processedProfile: ProcessedProfile | undefined;
    const result = await analyzeProfile(profilePath, {
      includePatterns: true,
      sourcePath,
      onProcessedProfile: (p) => {
        processedProfile = p;
      },
    });
    log(`  Analysis: ${result.hotspots.length} hotspots, ${result.patterns.length} patterns`);

    // Run explain
    log("  Running explain...");
    const explainResult: ExplainResult = await explainAnalysis(result, { apiKey, model });
    log(`  Explain: ${formatCallCost(explainResult.cost)}`);

    // Run deep analysis
    if (!processedProfile) {
      throw new Error(`processedProfile was not set for ${profileName}`);
    }
    log("  Running deep analysis...");
    const deepResult: DeepExplainResult = await deepAnalysis(
      result,
      processedProfile,
      { apiKey, model },
    );
    log(`  Deep: ${formatCallCost(deepResult.cost)}`);

    const elapsed = performance.now() - start;
    const costs: ApiCallCost[] = [explainResult.cost, deepResult.cost];

    // Build debug capture
    const capture: DebugCapture = {
      id: nextId(),
      token: crypto.randomUUID(),
      timestamp: new Date(),
      profileData,
      profileName,
      sourceZipData,
      analysisResult: result,
      costs,
      analysisDurationMs: Math.round(elapsed),
      model,
      explainCapture: {
        debugInfo: explainResult.debugInfo,
        parsedOutput: explainResult.text,
      },
      deepCapture: {
        debugInfo: deepResult.debugInfo,
        parsedOutput: {
          findings: deepResult.aiFindings,
          narrative: deepResult.aiNarrative,
        },
      },
    };

    const folder = await writeCaptureToDisk(
      capture, runDir, "developer-debug", undefined,
      basename(profilePath, ".alcpuprofile"),
    );
    log(`  Saved to: ${folder}`);
    log(`  Duration: ${(elapsed / 1000).toFixed(1)}s`);

    const totalCost = costs.reduce((sum, c) => sum + c.cost, 0);
    return totalCost;
  } finally {
    if (cleanup) {
      await cleanup();
    }
  }
}

// ── Diff Report Generation ──────────────────────────────────────────

interface RunProfileData {
  meta: { costs?: ApiCallCost[] };
  explainSystemPrompt?: string;
  explainUserPayload?: string;
  explainParsedOutput?: string;
  deepSystemPrompt?: string;
  deepUserPayload?: string;
  deepFindings?: AIFinding[];
  deepNarrative?: string;
}

async function readFileOr(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  return await readFile(path, "utf-8");
}

async function loadProfileData(profileDir: string): Promise<RunProfileData> {
  const metaRaw = await readFileOr(resolve(profileDir, "meta.json"));
  const meta = metaRaw ? JSON.parse(metaRaw) : {};

  const explainDir = resolve(profileDir, "explain");
  const deepDir = resolve(profileDir, "deep");

  const [explainSys, explainUser, explainOut, deepSys, deepUser, deepFindingsRaw] =
    await Promise.all([
      readFileOr(resolve(explainDir, "system-prompt.txt")),
      readFileOr(resolve(explainDir, "user-payload.json")),
      readFileOr(resolve(explainDir, "parsed-output.txt")),
      readFileOr(resolve(deepDir, "system-prompt.txt")),
      readFileOr(resolve(deepDir, "user-payload.json")),
      readFileOr(resolve(deepDir, "parsed-findings.json")),
    ]);

  let deepFindings: AIFinding[] | undefined;
  let deepNarrative: string | undefined;
  if (deepFindingsRaw) {
    try {
      const parsed = JSON.parse(deepFindingsRaw);
      deepFindings = parsed.findings;
      deepNarrative = parsed.narrative;
    } catch {
      // ignore parse errors
    }
  }

  return {
    meta,
    explainSystemPrompt: explainSys,
    explainUserPayload: explainUser,
    explainParsedOutput: explainOut,
    deepSystemPrompt: deepSys,
    deepUserPayload: deepUser,
    deepFindings,
    deepNarrative,
  };
}

function textDiff(oldText: string | undefined, newText: string | undefined, maxLines = 30): string {
  if (oldText === undefined && newText === undefined) return "_both missing_";
  if (oldText === undefined) return "_NEW (not in previous run)_";
  if (newText === undefined) return "_MISSING (not in current run)_";
  if (oldText === newText) return "unchanged";

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const diffLines: string[] = [];
  const maxIdx = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxIdx; i++) {
    const ol = i < oldLines.length ? oldLines[i] : undefined;
    const nl = i < newLines.length ? newLines[i] : undefined;
    if (ol === nl) continue;
    if (ol !== undefined) diffLines.push(`- ${ol}`);
    if (nl !== undefined) diffLines.push(`+ ${nl}`);
    if (diffLines.length >= maxLines) {
      diffLines.push(`... (diff truncated at ${maxLines} lines)`);
      break;
    }
  }

  if (diffLines.length === 0) return "unchanged";
  return "```diff\n" + diffLines.join("\n") + "\n```";
}

function compareFindingsStructured(
  oldFindings: AIFinding[] | undefined,
  newFindings: AIFinding[] | undefined,
): string {
  if (!oldFindings && !newFindings) return "_both missing_";
  if (!oldFindings) return "_NEW (no previous findings)_";
  if (!newFindings) return "_MISSING (no current findings)_";

  const oldByTitle = new Map(oldFindings.map((f) => [f.title, f]));
  const newByTitle = new Map(newFindings.map((f) => [f.title, f]));

  const lines: string[] = [];

  // Added
  for (const [title, f] of newByTitle) {
    if (!oldByTitle.has(title)) {
      lines.push(`- **ADDED**: ${title} [${f.severity}/${f.confidence}]`);
    }
  }

  // Removed
  for (const [title, f] of oldByTitle) {
    if (!newByTitle.has(title)) {
      lines.push(`- **REMOVED**: ${title} [${f.severity}/${f.confidence}]`);
    }
  }

  // Changed
  for (const [title, newF] of newByTitle) {
    const oldF = oldByTitle.get(title);
    if (!oldF) continue;
    const changes: string[] = [];
    if (oldF.severity !== newF.severity) changes.push(`severity: ${oldF.severity} → ${newF.severity}`);
    if (oldF.confidence !== newF.confidence) changes.push(`confidence: ${oldF.confidence} → ${newF.confidence}`);
    if (oldF.category !== newF.category) changes.push(`category: ${oldF.category} → ${newF.category}`);
    if (oldF.description !== newF.description) changes.push("description changed");
    if (oldF.suggestion !== newF.suggestion) changes.push("suggestion changed");
    if (changes.length > 0) {
      lines.push(`- **CHANGED**: ${title} (${changes.join("; ")})`);
    }
  }

  if (lines.length === 0) return "No changes in findings";
  return lines.join("\n");
}

function sumCosts(costs: ApiCallCost[] | undefined): {
  cost: number;
  inputTokens: number;
  outputTokens: number;
} {
  if (!costs || costs.length === 0) return { cost: 0, inputTokens: 0, outputTokens: 0 };
  return {
    cost: costs.reduce((s, c) => s + c.cost, 0),
    inputTokens: costs.reduce((s, c) => s + c.inputTokens, 0),
    outputTokens: costs.reduce((s, c) => s + c.outputTokens, 0),
  };
}

function fmtDelta(current: number, previous: number, prefix = "", suffix = ""): string {
  const delta = current - previous;
  if (delta === 0) return `${prefix}${current}${suffix}`;
  const sign = delta > 0 ? "+" : "";
  return `${prefix}${current}${suffix} (${sign}${prefix}${delta.toFixed(delta % 1 === 0 ? 0 : 4)}${suffix})`;
}

async function findPreviousRun(currentRunName: string): Promise<string | undefined> {
  const runsDir = resolve(EXAMPLE_DIR, "runs");
  if (!existsSync(runsDir)) return undefined;

  const entries = await readdir(runsDir);
  const sorted = entries.filter((e) => e < currentRunName).sort();
  if (sorted.length === 0) return undefined;
  return resolve(runsDir, sorted[sorted.length - 1]);
}

async function generateDiffReport(
  currentRunDir: string,
  previousRunDir: string,
  profiles: string[],
): Promise<string> {
  const currentName = basename(currentRunDir);
  const previousName = basename(previousRunDir);

  const profileNames = profiles.map((p) => basename(p, ".alcpuprofile"));

  // Also check for profiles that exist in previous but not current
  const prevEntries = await readdir(previousRunDir);
  const prevProfileNames = prevEntries.filter((e) => {
    const fullPath = resolve(previousRunDir, e);
    return existsSync(resolve(fullPath, "meta.json"));
  });

  const allProfileNames = [...new Set([...profileNames, ...prevProfileNames])].sort();

  // Load all profile data
  const currentData = new Map<string, RunProfileData>();
  const previousData = new Map<string, RunProfileData>();

  await Promise.all(
    allProfileNames.map(async (name) => {
      const curDir = resolve(currentRunDir, name);
      const prevDir = resolve(previousRunDir, name);
      if (existsSync(curDir)) currentData.set(name, await loadProfileData(curDir));
      if (existsSync(prevDir)) previousData.set(name, await loadProfileData(prevDir));
    }),
  );

  // Compute totals
  let curTotalCost = 0, curTotalIn = 0, curTotalOut = 0, curTotalFindings = 0;
  let prevTotalCost = 0, prevTotalIn = 0, prevTotalOut = 0, prevTotalFindings = 0;

  for (const d of currentData.values()) {
    const s = sumCosts(d.meta.costs);
    curTotalCost += s.cost;
    curTotalIn += s.inputTokens;
    curTotalOut += s.outputTokens;
    curTotalFindings += d.deepFindings?.length ?? 0;
  }
  for (const d of previousData.values()) {
    const s = sumCosts(d.meta.costs);
    prevTotalCost += s.cost;
    prevTotalIn += s.inputTokens;
    prevTotalOut += s.outputTokens;
    prevTotalFindings += d.deepFindings?.length ?? 0;
  }

  // Build report
  const lines: string[] = [];
  lines.push("# AI Quality Diff Report");
  lines.push("");
  lines.push(`**Current run**: \`${currentName}\``);
  lines.push(`**Previous run**: \`${previousName}\``);
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Current | Previous | Delta |");
  lines.push("|--------|---------|----------|-------|");

  const costDelta = curTotalCost - prevTotalCost;
  const inDelta = curTotalIn - prevTotalIn;
  const outDelta = curTotalOut - prevTotalOut;
  const findingsDelta = curTotalFindings - prevTotalFindings;

  const fmtSign = (v: number, decimals = 0) => {
    const s = decimals > 0 ? v.toFixed(decimals) : String(v);
    return v > 0 ? `+${s}` : s;
  };

  lines.push(`| Total cost | $${curTotalCost.toFixed(4)} | $${prevTotalCost.toFixed(4)} | ${fmtSign(costDelta, 4)} |`);
  lines.push(`| Input tokens | ${curTotalIn} | ${prevTotalIn} | ${fmtSign(inDelta)} |`);
  lines.push(`| Output tokens | ${curTotalOut} | ${prevTotalOut} | ${fmtSign(outDelta)} |`);
  lines.push(`| Findings count | ${curTotalFindings} | ${prevTotalFindings} | ${fmtSign(findingsDelta)} |`);
  lines.push("");

  // Per-profile sections
  for (const name of allProfileNames) {
    lines.push(`## ${name}`);
    lines.push("");

    const cur = currentData.get(name);
    const prev = previousData.get(name);

    if (!prev) {
      lines.push("**NEW** — not in previous run");
      lines.push("");
      continue;
    }
    if (!cur) {
      lines.push("**MISSING** — not in current run");
      lines.push("");
      continue;
    }

    // Cost comparison
    const curCost = sumCosts(cur.meta.costs);
    const prevCost = sumCosts(prev.meta.costs);
    lines.push(`### Cost`);
    lines.push(`- Cost: ${fmtDelta(curCost.cost, prevCost.cost, "$")}`);
    lines.push(`- Input tokens: ${fmtDelta(curCost.inputTokens, prevCost.inputTokens)}`);
    lines.push(`- Output tokens: ${fmtDelta(curCost.outputTokens, prevCost.outputTokens)}`);
    lines.push("");

    // Input changes
    lines.push("### Inputs");
    lines.push("");

    lines.push("#### Explain system prompt");
    lines.push(textDiff(prev.explainSystemPrompt, cur.explainSystemPrompt));
    lines.push("");

    lines.push("#### Explain user payload");
    lines.push(textDiff(prev.explainUserPayload, cur.explainUserPayload));
    lines.push("");

    lines.push("#### Deep system prompt");
    lines.push(textDiff(prev.deepSystemPrompt, cur.deepSystemPrompt));
    lines.push("");

    lines.push("#### Deep user payload");
    lines.push(textDiff(prev.deepUserPayload, cur.deepUserPayload));
    lines.push("");

    // Output changes
    lines.push("### Outputs");
    lines.push("");

    lines.push("#### Explain narrative");
    lines.push(textDiff(prev.explainParsedOutput, cur.explainParsedOutput));
    lines.push("");

    lines.push("#### Deep findings");
    lines.push(compareFindingsStructured(prev.deepFindings, cur.deepFindings));
    lines.push("");

    lines.push("#### Deep narrative");
    lines.push(textDiff(prev.deepNarrative, cur.deepNarrative));
    lines.push("");
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  // Parse --model argument
  const modelArg = process.argv.find((a) => a.startsWith("--model="))?.split("=")[1]
    ?? (process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : undefined);
  const model: ExplainModel = modelArg === "opus" ? "opus" : "sonnet";

  // Fail fast if no API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log("ERROR: ANTHROPIC_API_KEY environment variable is not set");
    process.exit(1);
  }

  // Scan for profiles
  const entries = await readdir(EXAMPLE_DIR);
  const profiles = entries
    .filter((e) => e.endsWith(".alcpuprofile"))
    .map((e) => resolve(EXAMPLE_DIR, e))
    .sort();

  if (profiles.length === 0) {
    log("ERROR: No .alcpuprofile files found in exampledata/");
    process.exit(1);
  }

  log(`Found ${profiles.length} profiles (model: ${model})`);

  // Create timestamped run folder
  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "");
  const runDir = resolve(EXAMPLE_DIR, "runs", timestamp);
  await mkdir(runDir, { recursive: true });
  log(`Run folder: ${runDir}`);

  // Initialize ID counter from run folder
  await initIdCounter(runDir);

  const overallStart = performance.now();
  let totalCost = 0;

  for (const profilePath of profiles) {
    const cost = await analyzeOne(profilePath, runDir, apiKey, model);
    totalCost += cost;
  }

  const overallElapsed = performance.now() - overallStart;

  log("\n=== Summary ===");
  log(`Profiles analyzed: ${profiles.length}`);
  log(`Total time: ${(overallElapsed / 1000).toFixed(1)}s`);
  log(`Total cost: $${totalCost.toFixed(4)}`);

  // Generate diff report against previous run
  const previousRunDir = await findPreviousRun(timestamp);
  if (previousRunDir) {
    log(`\nGenerating diff report against: ${basename(previousRunDir)}`);
    const diffReport = await generateDiffReport(runDir, previousRunDir, profiles);
    const diffPath = resolve(runDir, "diff-report.md");
    await fsWriteFile(diffPath, diffReport, "utf-8");
    log(`Diff report saved: ${diffPath}`);
  } else {
    log("\nNo previous run found — skipping diff report");
  }
}

main().catch((err) => {
  log(`FATAL: ${err.message ?? err}`);
  process.exit(1);
});
