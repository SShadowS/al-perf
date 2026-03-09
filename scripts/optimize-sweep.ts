/**
 * optimize-sweep.ts — Master script for Phase 0+1 optimization sweep.
 *
 * Runs Opus baseline × N, then each Sonnet config × N,
 * then aggregate comparisons of each config against Opus.
 *
 * Usage:
 *   bun run scripts/optimize-sweep.ts                          # full sweep
 *   bun run scripts/optimize-sweep.ts --skip-opus              # reuse existing Opus runs
 *   bun run scripts/optimize-sweep.ts --configs baseline,+ast  # specific configs only
 *   bun run scripts/optimize-sweep.ts --runs 3                 # runs per config (default 3)
 *   bun run scripts/optimize-sweep.ts --opus-runs run1,run2    # specify existing Opus runs
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

import { readdir, readFile, writeFile, mkdir, stat } from "fs/promises";
import { resolve, basename } from "path";
import { existsSync } from "fs";
import { PAYLOAD_PRESETS } from "../src/explain/deep-analyzer.js";

const RUNS_DIR = resolve(import.meta.dir, "..", "exampledata", "runs");
const OPTIMIZE_MD = resolve(import.meta.dir, "..", "Optimize.md");

function log(msg: string): void {
  process.stderr.write(msg + "\n");
}

function parseArg(name: string): string | undefined {
  const eqForm = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  if (eqForm !== undefined) return eqForm;
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

interface SweepProgress {
  opusRuns: string[];
  configRuns: Record<string, string[]>;
  comparisons: Record<string, string>;  // config → comparison report path
}

async function loadProgress(): Promise<SweepProgress> {
  const path = resolve(RUNS_DIR, "sweep-progress.json");
  if (existsSync(path)) {
    return JSON.parse(await readFile(path, "utf-8"));
  }
  return { opusRuns: [], configRuns: {}, comparisons: {} };
}

async function saveProgress(progress: SweepProgress): Promise<void> {
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(resolve(RUNS_DIR, "sweep-progress.json"), JSON.stringify(progress, null, 2), "utf-8");
}

async function runTestScript(args: string[]): Promise<string[]> {
  const cmd = ["bun", "run", "scripts/test-ai-quality.ts", ...args, "--no-diff"];
  log(`  $ ${cmd.join(" ")}`);

  const proc = Bun.spawn(cmd, {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    log(`  ERROR: test script failed (exit ${proc.exitCode})`);
    log(stderr);
    throw new Error(`test script failed for args: ${args.join(" ")}`);
  }

  // Extract run folder names from output
  const runFolderMatch = stderr.match(/Run folders?: (.+)/);
  if (runFolderMatch) {
    return runFolderMatch[1].split(", ").map((s) => s.trim());
  }

  // Fallback: extract from "Run folder:" lines
  const singleMatch = stderr.match(/Run folder: .+[/\\]runs[/\\](.+)/);
  if (singleMatch) {
    return [singleMatch[1]];
  }

  throw new Error("Could not extract run folder names from output");
}

async function runCompareScript(aRuns: string[], bRuns: string[]): Promise<string> {
  const cmd = [
    "bun", "run", "scripts/compare-ai-quality.ts",
    "--aggregate",
    "--a", aRuns.join(","),
    "--b", bRuns.join(","),
  ];
  log(`  $ ${cmd.join(" ")}`);

  const proc = Bun.spawn(cmd, {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    log(`  ERROR: compare script failed (exit ${proc.exitCode})`);
    log(stderr);
    throw new Error("compare script failed");
  }

  // Find the report path from stderr
  const reportMatch = stderr.match(/Report saved to: (.+)/);
  return reportMatch ? reportMatch[1].trim() : "";
}

interface ComparisonScores {
  profiles: Array<{
    name: string;
    groupA_avg: number;
    groupB_avg: number;
    winner: string;
    notes?: string;
  }>;
  overall: {
    a_wins: number;
    b_wins: number;
    draws: number;
    verdict: string;
  };
}

async function loadScores(reportDir: string): Promise<ComparisonScores | null> {
  const scoresPath = resolve(reportDir, "comparison-scores.json");
  if (!existsSync(scoresPath)) return null;
  try {
    return JSON.parse(await readFile(scoresPath, "utf-8"));
  } catch {
    return null;
  }
}

async function generateResultsMatrix(
  progress: SweepProgress,
): Promise<string> {
  const lines: string[] = [];
  lines.push("\n## Phase 1 Results Matrix\n");
  lines.push("| Config | Opus Runs | Sonnet Runs | vs Opus W/L/D | Verdict | Notes |");
  lines.push("|--------|-----------|-------------|---------------|---------|-------|");

  for (const [configName, runs] of Object.entries(progress.configRuns)) {
    const reportPath = progress.comparisons[configName];
    let verdict = "pending";
    let wld = "—";
    let notes = "";

    if (reportPath) {
      const reportDir = resolve(reportPath, "..");
      const scores = await loadScores(reportDir);
      if (scores) {
        wld = `${scores.overall.b_wins}-${scores.overall.a_wins}-${scores.overall.draws}`;
        verdict = scores.overall.verdict === "B" ? "Sonnet" : scores.overall.verdict === "A" ? "Opus" : "Draw";
        // Average scores
        const avgA = scores.profiles.reduce((s, p) => s + p.groupA_avg, 0) / scores.profiles.length;
        const avgB = scores.profiles.reduce((s, p) => s + p.groupB_avg, 0) / scores.profiles.length;
        notes = `Opus avg: ${avgA.toFixed(1)}, Sonnet avg: ${avgB.toFixed(1)}`;
      }
    }

    lines.push(`| ${configName} | ${progress.opusRuns.length} | ${runs.length} | ${wld} | ${verdict} | ${notes} |`);
  }

  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const skipOpus = process.argv.includes("--skip-opus");
  const configsArg = parseArg("configs");
  const numRuns = parseInt(parseArg("runs") ?? "3", 10);
  const opusRunsArg = parseArg("opus-runs");
  const promptArg = parseArg("prompt");

  const allConfigs = configsArg
    ? configsArg.split(",").map((s) => s.trim()).filter(Boolean)
    : Object.keys(PAYLOAD_PRESETS).filter((k) => k !== "current");

  // Validate configs
  for (const c of allConfigs) {
    if (!PAYLOAD_PRESETS[c]) {
      log(`ERROR: Unknown config "${c}". Available: ${Object.keys(PAYLOAD_PRESETS).join(", ")}`);
      process.exit(1);
    }
  }

  log("=== Optimization Sweep ===");
  log(`Configs: ${allConfigs.join(", ")}`);
  log(`Runs per config: ${numRuns}`);
  log(`Skip Opus: ${skipOpus}`);
  log("");

  let progress = await loadProgress();

  // Phase 0: Opus baseline
  if (opusRunsArg) {
    progress.opusRuns = opusRunsArg.split(",").map((s) => s.trim());
    log(`Using specified Opus runs: ${progress.opusRuns.join(", ")}`);
  } else if (skipOpus && progress.opusRuns.length > 0) {
    log(`Reusing ${progress.opusRuns.length} existing Opus runs: ${progress.opusRuns.join(", ")}`);
  } else if (!skipOpus) {
    log("--- Phase 0: Opus baseline ---");
    const opusRuns = await runTestScript(["--model", "opus", "--runs", String(numRuns)]);
    progress.opusRuns = opusRuns;
    await saveProgress(progress);
    log(`Opus runs: ${opusRuns.join(", ")}\n`);
  }

  if (progress.opusRuns.length === 0) {
    log("ERROR: No Opus baseline runs available. Run without --skip-opus first.");
    process.exit(1);
  }

  // Phase 1: Sonnet configs
  log("--- Phase 1: Sonnet config variants ---");
  for (const configName of allConfigs) {
    if (progress.configRuns[configName]?.length >= numRuns) {
      log(`\n[${configName}] Already have ${progress.configRuns[configName].length} runs, skipping.`);
      continue;
    }

    log(`\n[${configName}] Running ${numRuns} Sonnet runs...`);
    const args = ["--config", configName, "--runs", String(numRuns)];
    if (promptArg) args.push("--prompt", promptArg);
    const runs = await runTestScript(args);
    progress.configRuns[configName] = runs;
    await saveProgress(progress);
    log(`  Runs: ${runs.join(", ")}`);
  }

  // Comparisons
  log("\n--- Aggregate Comparisons ---");
  for (const configName of allConfigs) {
    const sonnetRuns = progress.configRuns[configName];
    if (!sonnetRuns || sonnetRuns.length === 0) continue;

    if (progress.comparisons[configName]) {
      log(`[${configName}] Already compared, skipping.`);
      continue;
    }

    log(`\n[${configName}] Comparing ${sonnetRuns.length} Sonnet runs vs ${progress.opusRuns.length} Opus runs...`);
    try {
      const reportPath = await runCompareScript(progress.opusRuns, sonnetRuns);
      progress.comparisons[configName] = reportPath;
      await saveProgress(progress);
    } catch (err) {
      log(`  WARNING: Comparison failed for ${configName}: ${err}`);
    }
  }

  // Generate results matrix
  log("\n--- Generating Results Matrix ---");
  const matrix = await generateResultsMatrix(progress);
  log(matrix);

  // Append to Optimize.md
  if (existsSync(OPTIMIZE_MD)) {
    const existing = await readFile(OPTIMIZE_MD, "utf-8");
    if (!existing.includes("## Phase 1 Results Matrix")) {
      await writeFile(OPTIMIZE_MD, existing + matrix, "utf-8");
      log("Appended results matrix to Optimize.md");
    } else {
      log("Results matrix already exists in Optimize.md — not overwriting");
    }
  }

  log("\n=== Sweep Complete ===");
}

main().catch((err) => {
  log(`FATAL: ${err.message ?? err}`);
  process.exit(1);
});
