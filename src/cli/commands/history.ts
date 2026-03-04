import { Command } from "commander";
import { HistoryStore } from "../../history/store.js";
import { formatTime } from "../../core/analyzer.js";
import chalk from "chalk";
import Table from "cli-table3";

export function createHistoryCommand(): Command {
  const cmd = new Command("history")
    .description("Manage performance analysis history")
    .option("--history-dir <dir>", "History store directory", ".al-perf-history");

  cmd.command("list")
    .description("List stored analysis entries")
    .option("-n, --limit <n>", "Maximum entries to show", "20")
    .option("--label <label>", "Filter by label")
    .option("--profile <path>", "Filter by profile path (substring)")
    .action((opts) => {
      const store = new HistoryStore(cmd.opts().historyDir);
      const entries = store.query({
        limit: parseInt(opts.limit),
        label: opts.label,
        profilePath: opts.profile,
      });

      if (entries.length === 0) {
        console.log("No history entries found.");
        return;
      }

      const table = new Table({
        head: [
          chalk.gray("Timestamp"),
          chalk.gray("Profile"),
          chalk.gray("Type"),
          chalk.gray("Duration"),
          chalk.gray("Health"),
          chalk.gray("Patterns"),
          chalk.gray("Label"),
        ],
        style: { head: [], border: [] },
      });

      for (const e of entries) {
        const patternStr = `${e.metrics.patternCount.critical}C/${e.metrics.patternCount.warning}W/${e.metrics.patternCount.info}I`;
        table.push([
          e.timestamp.slice(0, 19),
          e.profilePath.split("/").pop() ?? e.profilePath,
          e.profileType,
          formatTime(e.metrics.totalDuration),
          `${e.metrics.healthScore}/100`,
          patternStr,
          e.label ?? "-",
        ]);
      }

      console.log(table.toString());
    });

  cmd.command("trend")
    .description("Show metric trends across history entries")
    .option("--profile <path>", "Filter by profile path")
    .option("-n, --limit <n>", "Maximum entries", "10")
    .action((opts) => {
      const store = new HistoryStore(cmd.opts().historyDir);
      const entries = store.query({
        limit: parseInt(opts.limit),
        profilePath: opts.profile,
      }).reverse(); // oldest first for trend

      if (entries.length < 2) {
        console.log("Need at least 2 history entries for trend analysis.");
        return;
      }

      console.log(chalk.bold("Performance Trend"));
      console.log("");

      for (const e of entries) {
        const barStr = "\u2588".repeat(Math.min(50, Math.round(e.metrics.healthScore / 2)));
        const label = e.label ? ` [${e.label}]` : "";
        console.log(`  ${e.timestamp.slice(0, 10)}  ${barStr} ${e.metrics.healthScore}/100  ${formatTime(e.metrics.totalSelfTime)}${label}`);
      }

      // Delta between first and last
      const first = entries[0];
      const last = entries[entries.length - 1];
      const delta = last.metrics.totalSelfTime - first.metrics.totalSelfTime;
      const sign = delta >= 0 ? "+" : "";
      console.log("");
      console.log(`  Trend: ${sign}${formatTime(delta)} over ${entries.length} entries`);
    });

  cmd.command("clear")
    .description("Clear all history entries")
    .action(() => {
      const store = new HistoryStore(cmd.opts().historyDir);
      const count = store.count();
      store.clearAll();
      console.log(`Cleared ${count} history entries.`);
    });

  return cmd;
}
