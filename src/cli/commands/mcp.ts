import type { Command } from "commander";

export function registerMcpCommand(program: Command) {
  program
    .command("mcp")
    .description("Start MCP server (stdio transport) for use with Claude Code")
    .option("-s, --source <path>", "Default AL source directory for all tools")
    .action(async (opts: { source?: string }) => {
      const { StdioServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/stdio.js"
      );
      const { createMcpServer } = await import("../../mcp/server.js");

      const server = createMcpServer({
        defaultSourcePath: opts.source,
      });
      const transport = new StdioServerTransport();
      await server.connect(transport);
    });
}
