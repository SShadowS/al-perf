#!/usr/bin/env bun
import { Command } from "commander";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerHotspotsCommand } from "./commands/hotspots.js";
import { registerCompareCommand } from "./commands/compare.js";

const program = new Command();

program
  .name("al-profile")
  .description("Analyze Business Central .alcpuprofile files")
  .version("0.1.0");

registerAnalyzeCommand(program);
registerHotspotsCommand(program);
registerCompareCommand(program);

program.parse();
