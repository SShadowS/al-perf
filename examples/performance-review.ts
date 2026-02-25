#!/usr/bin/env bun
/**
 * Example: Automated Performance Review Agent
 *
 * This script demonstrates using the al-profile-analyzer library
 * to build an automated performance review pipeline.
 *
 * Usage: bun run examples/performance-review.ts <profile-path> [source-path]
 */
// When installed via npm, import from "al-profile-analyzer" instead
import { analyzeProfile } from "../src/index.js";

const profilePath = process.argv[2];
const sourcePath = process.argv[3];

if (!profilePath) {
  console.error("Usage: bun run examples/performance-review.ts <profile> [source-dir]");
  process.exit(1);
}

async function main() {
  console.log(`\nAnalyzing: ${profilePath}`);
  if (sourcePath) console.log(`Source: ${sourcePath}`);
  console.log("---");

  const result = await analyzeProfile(profilePath, {
    top: 10,
    includePatterns: true,
    sourcePath,
  });

  // 1. Summary
  console.log(`\nProfile: ${result.meta.profileType}`);
  console.log(`Summary: ${result.summary.oneLiner}`);

  // 2. Critical findings
  const critical = result.patterns.filter((p) => p.severity === "critical");
  const warnings = result.patterns.filter((p) => p.severity === "warning");

  if (critical.length > 0) {
    console.log(`\n${critical.length} CRITICAL issue(s):`);
    for (const p of critical) {
      console.log(`  - ${p.title}`);
      console.log(`    ${p.description}`);
      if (p.suggestion) console.log(`    Fix: ${p.suggestion}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\n${warnings.length} WARNING(s):`);
    for (const p of warnings) {
      console.log(`  - ${p.title}`);
      if (p.suggestion) console.log(`    Fix: ${p.suggestion}`);
    }
  }

  // 3. Top hotspots
  console.log(`\nTop ${result.hotspots.length} Hotspots:`);
  for (const [i, h] of result.hotspots.entries()) {
    console.log(`  ${i + 1}. ${h.functionName} (${h.objectType} ${h.objectId}) — ${h.selfTimePercent.toFixed(1)}% self time`);
  }

  // 4. Verdict
  if (critical.length > 0) {
    console.log("\nFAILED: Critical performance issues detected.");
    process.exit(1);
  } else if (warnings.length > 3) {
    console.log("\nWARNING: Multiple performance concerns.");
    process.exit(0);
  } else {
    console.log("\nPASSED: No critical issues.");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
