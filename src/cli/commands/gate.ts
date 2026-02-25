import type { Command } from "commander";
import { analyzeProfile } from "../../core/analyzer.js";
import { findCompanionZip, extractCompanionZip } from "../../source/zip-extractor.js";

export interface GateResult {
  verdict: "pass" | "fail";
  profilePath: string;
  counts: { critical: number; warning: number; info: number };
  thresholds: { maxCritical: number; maxWarning: number | null };
  violations: string[];
  patterns: Array<{ severity: string; title: string; impact: number; suggestion?: string }>;
}

export function registerGateCommand(program: Command) {
  program
    .command("gate")
    .description("CI/CD quality gate — exit 1 if pattern thresholds exceeded")
    .argument("<profile>", "Path to .alcpuprofile file")
    .option("--max-critical <n>", "Max critical patterns before failing (default: 0)", "0")
    .option("--max-warning <n>", "Max warning patterns before failing (default: unlimited)")
    .option("-s, --source <path>", "Path to AL source directory")
    .option("-f, --format <format>", "Output format: text|json", "text")
    .action(async (profilePath: string, opts: any) => {
      const maxCritical = parseInt(opts.maxCritical, 10);
      const maxWarning = opts.maxWarning !== undefined ? parseInt(opts.maxWarning, 10) : Infinity;

      let sourcePath: string | undefined = opts.source;
      let cleanup: (() => Promise<void>) | undefined;

      if (!sourcePath) {
        const zipPath = findCompanionZip(profilePath);
        if (zipPath) {
          const extracted = await extractCompanionZip(zipPath);
          sourcePath = extracted.extractDir;
          cleanup = extracted.cleanup;
        }
      }

      const analysis = await analyzeProfile(profilePath, {
        includePatterns: true,
        sourcePath,
      });

      if (cleanup) await cleanup();

      const counts = { critical: 0, warning: 0, info: 0 };
      for (const p of analysis.patterns) {
        counts[p.severity]++;
      }

      const violations: string[] = [];
      if (counts.critical > maxCritical) {
        violations.push(`critical: ${counts.critical} > ${maxCritical}`);
      }
      if (counts.warning > maxWarning) {
        violations.push(`warning: ${counts.warning} > ${maxWarning}`);
      }

      const verdict: "pass" | "fail" = violations.length === 0 ? "pass" : "fail";

      const result: GateResult = {
        verdict,
        profilePath,
        counts,
        thresholds: { maxCritical, maxWarning: maxWarning === Infinity ? null : maxWarning },
        violations,
        patterns: analysis.patterns.map((p) => ({
          severity: p.severity,
          title: p.title,
          impact: p.impact,
          suggestion: p.suggestion,
        })),
      };

      if (opts.format === "json") {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        const icon = verdict === "pass" ? "PASS" : "FAIL";
        process.stdout.write(`${icon}: ${counts.critical} critical, ${counts.warning} warning, ${counts.info} info\n`);
        for (const v of violations) {
          process.stdout.write(`  Threshold exceeded: ${v}\n`);
        }
        if (analysis.patterns.length > 0) {
          process.stdout.write("\nPatterns:\n");
          for (const p of analysis.patterns) {
            process.stdout.write(`  [${p.severity}] ${p.title}\n`);
          }
        }
      }

      process.exit(verdict === "pass" ? 0 : 1);
    });
}
