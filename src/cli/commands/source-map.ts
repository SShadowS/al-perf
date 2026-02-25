import { Command } from "commander";
import { buildSourceIndex } from "../../source/indexer.js";
import { resolveFormat } from "../formatters/auto.js";

export const sourceMapCommand = new Command("source-map")
  .description("Build and inspect the AL source index")
  .argument("<source-path>", "Path to AL source directory")
  .option("-f, --format <format>", "Output format: auto|terminal|json|markdown", "auto")
  .action(async (sourcePath: string, opts) => {
    const index = await buildSourceIndex(sourcePath);
    const format = resolveFormat(opts.format);

    let procedureCount = 0;
    let triggerCount = 0;
    for (const procs of index.procedures.values()) {
      procedureCount += procs.length;
    }
    for (const trigs of index.triggers.values()) {
      triggerCount += trigs.length;
    }

    if (format === "json") {
      const output = {
        files: index.files,
        objects: Array.from(index.objects.entries()).map(([key, obj]) => ({
          key,
          objectType: obj.objectType,
          objectName: obj.objectName,
          objectId: obj.objectId,
          procedureCount: obj.procedures.length,
          triggerCount: obj.triggers.length,
          procedures: obj.procedures.map((p) => ({
            name: p.name,
            lineStart: p.lineStart,
            lineEnd: p.lineEnd,
            loopCount: p.features.loops.length,
            recordOpsInLoopCount: p.features.recordOpsInLoops.length,
          })),
          triggers: obj.triggers.map((t) => ({
            name: t.name,
            lineStart: t.lineStart,
            lineEnd: t.lineEnd,
            loopCount: t.features.loops.length,
            recordOpsInLoopCount: t.features.recordOpsInLoops.length,
          })),
        })),
        procedureCount,
        triggerCount,
      };
      process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    } else {
      const chalk = (await import("chalk")).default;
      const lines: string[] = [];
      lines.push("");
      lines.push(chalk.bold.cyan("\u2500\u2500 Source Index \u2500\u2500"));
      lines.push(`  Files: ${index.files.length}`);
      lines.push(`  Objects: ${index.objects.size}`);
      lines.push(`  Procedures: ${procedureCount}`);
      lines.push(`  Triggers: ${triggerCount}`);
      lines.push("");

      for (const [, obj] of index.objects) {
        lines.push(
          chalk.bold(`  ${obj.objectType} ${obj.objectId} "${obj.objectName}"`),
        );
        for (const proc of obj.procedures) {
          const loopTag =
            proc.features.loops.length > 0
              ? chalk.yellow(` [${proc.features.loops.length} loops]`)
              : "";
          const opTag =
            proc.features.recordOpsInLoops.length > 0
              ? chalk.red(
                  ` [${proc.features.recordOpsInLoops.length} record ops in loops]`,
                )
              : "";
          lines.push(
            `    procedure ${proc.name} (L${proc.lineStart}-${proc.lineEnd})${loopTag}${opTag}`,
          );
        }
        for (const trig of obj.triggers) {
          lines.push(
            `    trigger ${trig.name} (L${trig.lineStart}-${trig.lineEnd})`,
          );
        }
        lines.push("");
      }

      process.stdout.write(lines.join("\n") + "\n");
    }
  });
