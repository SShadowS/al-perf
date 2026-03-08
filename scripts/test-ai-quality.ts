/**
 * test-ai-quality.ts — Run AI analysis (explain + deep) across all example profiles
 * and capture debug output for quality review.
 *
 * Usage: bun run scripts/test-ai-quality.ts
 * Requires: ANTHROPIC_API_KEY environment variable
 */

import { analyzeProfile } from "../src/core/analyzer.js";
import { explainAnalysis, type ExplainResult } from "../src/explain/explainer.js";
import { deepAnalysis, type DeepExplainResult } from "../src/explain/deep-analyzer.js";
import { findCompanionZip, extractCompanionZip } from "../src/source/zip-extractor.js";
import { writeCaptureToDisk } from "../src/debug/writer.js";
import { initIdCounter, nextId } from "../src/debug/ids.js";
import type { DebugCapture } from "../src/debug/types.js";
import type { ProcessedProfile } from "../src/types/processed.js";
import type { ApiCallCost } from "../src/explain/api-cost.js";
import { formatCallCost, summarizeCosts } from "../src/explain/api-cost.js";
import { readdir, mkdir } from "fs/promises";
import { resolve, basename } from "path";

const EXAMPLE_DIR = resolve(import.meta.dir, "..", "exampledata");

function log(msg: string): void {
  process.stderr.write(msg + "\n");
}

async function analyzeOne(
  profilePath: string,
  runDir: string,
  apiKey: string,
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
    const explainResult: ExplainResult = await explainAnalysis(result, { apiKey });
    log(`  Explain: ${formatCallCost(explainResult.cost)}`);

    // Run deep analysis
    log("  Running deep analysis...");
    const deepResult: DeepExplainResult = await deepAnalysis(
      result,
      processedProfile!,
      { apiKey },
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
      model: "sonnet",
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

    const folder = await writeCaptureToDisk(capture, runDir, "developer-debug");
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

async function main(): Promise<void> {
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

  log(`Found ${profiles.length} profiles in exampledata/`);

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
    const cost = await analyzeOne(profilePath, runDir, apiKey);
    totalCost += cost;
  }

  const overallElapsed = performance.now() - overallStart;

  log("\n=== Summary ===");
  log(`Profiles analyzed: ${profiles.length}`);
  log(`Total time: ${(overallElapsed / 1000).toFixed(1)}s`);
  log(`Total cost: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  log(`FATAL: ${err.message ?? err}`);
  process.exit(1);
});
