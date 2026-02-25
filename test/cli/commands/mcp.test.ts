import { describe, test, expect } from "bun:test";

const CLI = "src/cli/index.ts";

describe("CLI mcp command", () => {
  test("--help lists mcp command", async () => {
    const result = await Bun.spawn(["bun", "run", CLI, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(result.stdout).text();
    expect(text).toContain("mcp");
  });
});
