import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = "src/cli/index.ts";

/**
 * A malformed profile is ordinary user input — a truncated download, the wrong
 * file, a half-written capture. The CLI answered it with a raw Bun crash dump:
 * six lines of the parser's own source, a caret, and absolute paths into the
 * install directory. That is unreadable for a user, useless for a script, and
 * it leaks internals.
 */
async function runCli(args: string[]) {
	const proc = Bun.spawn(["bun", "run", CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	// Drain both pipes BEFORE awaiting exit: output past the 64 KiB Windows
	// pipe buffer otherwise deadlocks.
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { stdout, stderr, exitCode: proc.exitCode };
}

describe("CLI error handling for malformed input", () => {
	const dir = mkdtempSync(join(tmpdir(), "alperf-bad-"));

	const cases: Array<[string, string]> = [
		["empty file", ""],
		["truncated json", '{"nodes":['],
		["valid json, wrong shape", '{"hello":"world"}'],
		[
			"no nodes",
			'{"nodes":[],"startTime":0,"endTime":0,"samples":[],"timeDeltas":[],"kind":1}',
		],
	];

	for (const [label, content] of cases) {
		test(`${label}: one clean message, no stack trace, exit 1`, async () => {
			const path = join(dir, `${label.replace(/\W+/g, "-")}.alcpuprofile`);
			writeFileSync(path, content);
			const { stderr, exitCode } = await runCli([
				"analyze",
				path,
				"-f",
				"json",
			]);

			expect(exitCode).toBe(1);
			expect(stderr).toMatch(/^Error: /m);
			// The crash dump's fingerprints: source excerpts with line-number
			// gutters, a caret line, and `at fn (path:line:col)` frames.
			expect(stderr).not.toMatch(/^\s*\d+ \|/m);
			expect(stderr).not.toMatch(/^\s+at .+:\d+:\d+/m);
			expect(stderr).not.toContain("src/core/parser.ts");
			expect(stderr.trim().split("\n").length).toBeLessThanOrEqual(3);
		});
	}

	test("a missing file says so, rather than dumping a trace", async () => {
		const { stderr, exitCode } = await runCli([
			"analyze",
			join(dir, "does-not-exist.alcpuprofile"),
			"-f",
			"json",
		]);
		expect(exitCode).toBe(1);
		expect(stderr).toMatch(/^Error: /m);
		expect(stderr).not.toMatch(/^\s+at .+:\d+:\d+/m);
	});

	test("a valid profile still succeeds", async () => {
		const { stdout, exitCode } = await runCli([
			"analyze",
			"test/fixtures/sampling-minimal.alcpuprofile",
			"-f",
			"json",
		]);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout).meta).toBeDefined();
	});

	test("cleanup", () => {
		rmSync(dir, { recursive: true, force: true });
		expect(true).toBe(true);
	});
});
