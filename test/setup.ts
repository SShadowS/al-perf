/**
 * Test preload (wired via bunfig.toml).
 *
 * Bun auto-loads `.env`, so a developer's real ANTHROPIC_API_KEY leaks into
 * every test process. Code paths that run deep analysis whenever a key is
 * present — the MCP `analyze_profile` tool (src/mcp/server.ts) and the web
 * server's analyze/ingest handlers — then make live API calls against test
 * fixtures: minutes of wall clock, real spend, and 5s test timeouts that look
 * like regressions. CI has no `.env`, so this is invisible there.
 *
 * AI_DISABLED=1 is the existing kill-switch contract honored by mcp, web and
 * lifecycle triage. Set it here rather than in the package.json script so it
 * also covers `bun test <file>`. Child processes spawned by tests inherit
 * process.env, so the CLI/server subprocess tests are covered too.
 *
 * Set AL_PERF_TEST_LIVE_AI=1 to opt back in to real API calls.
 */
if (process.env.AL_PERF_TEST_LIVE_AI !== "1") {
	process.env.AI_DISABLED = "1";
}
