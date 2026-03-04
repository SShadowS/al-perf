#!/usr/bin/env bun
import { Command } from "commander";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerHotspotsCommand } from "./commands/hotspots.js";
import { registerCompareCommand } from "./commands/compare.js";
import { explainCommand } from "./commands/explain.js";
import { sourceMapCommand } from "./commands/source-map.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerGateCommand } from "./commands/gate.js";
import { registerAnalyzeSourceCommand } from "./commands/analyze-source.js";
import { createHistoryCommand } from "./commands/history.js";
import pkg from "../../package.json";

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

program.parse();
