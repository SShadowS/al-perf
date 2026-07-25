#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../../package.json";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerAnalyzeSourceCommand } from "./commands/analyze-source.js";
import { registerBatchCommand } from "./commands/batch.js";
import { registerCompareCommand } from "./commands/compare.js";
import { explainCommand } from "./commands/explain.js";
import { registerGateCommand } from "./commands/gate.js";
import { createHistoryCommand } from "./commands/history.js";
import { registerHotspotsCommand } from "./commands/hotspots.js";
import { createLifecycleCommand } from "./commands/lifecycle.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { sourceMapCommand } from "./commands/source-map.js";

const program = new Command();

program
	.name("al-profile")
	.description("Analyze Business Central .alcpuprofile files")
	.version(pkg.version);

registerAnalyzeCommand(program);
registerHotspotsCommand(program);
registerCompareCommand(program);
program.addCommand(explainCommand);
program.addCommand(sourceMapCommand);
registerMcpCommand(program);
registerGateCommand(program);
registerAnalyzeSourceCommand(program);
program.addCommand(createHistoryCommand());
program.addCommand(createLifecycleCommand());
registerBatchCommand(program);

/**
 * One place that turns an unhandled failure into something a person or a
 * script can use.
 *
 * A malformed profile is ordinary user input — a truncated download, the wrong
 * file, a half-written capture. Without this, the answer was a raw Bun crash
 * dump: six lines of the failing module's own source, a caret, and absolute
 * paths into the install directory. Unreadable for a user, useless for a
 * script, and it leaks internals. Most subcommands have no error handling of
 * their own, so this belongs at the entry point rather than in eleven files.
 *
 * `AL_PERF_TRACE=1` restores the full stack for debugging the tool itself.
 */
function reportFatal(err: unknown): never {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`Error: ${message}`);
	if (process.env.AL_PERF_TRACE === "1" && err instanceof Error && err.stack) {
		console.error(err.stack);
	} else {
		console.error("Re-run with AL_PERF_TRACE=1 for the full stack trace.");
	}
	process.exit(1);
}

process.on("uncaughtException", reportFatal);
process.on("unhandledRejection", reportFatal);

program.parseAsync().catch(reportFatal);
