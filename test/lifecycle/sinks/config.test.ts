/**
 * config.test.ts — sink config loading, defaults (digest-first: autoFile and
 * autoClose OFF), validation, severity ranking.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	loadSinksConfig,
	resolveGitHubConfig,
	SINK_DEFAULTS,
	severityRank,
} from "../../../src/lifecycle/sinks/types.js";

describe("SINK_DEFAULTS", () => {
	it("is digest-first: autoFile and autoClose are OFF by default", () => {
		expect(SINK_DEFAULTS.autoFile).toBe(false);
		expect(SINK_DEFAULTS.autoClose).toBe(false);
		expect(SINK_DEFAULTS.autoFileAfterRuns).toBe(2);
		expect(SINK_DEFAULTS.autoFileMinSeverity).toBe("critical");
		expect(SINK_DEFAULTS.tokenEnv).toBe("GITHUB_TOKEN");
	});
});

describe("resolveGitHubConfig", () => {
	it("merges defaults under explicit values", () => {
		const cfg = resolveGitHubConfig({
			enabled: true,
			repo: "owner/repo",
			autoFile: true,
		});
		expect(cfg.autoFile).toBe(true);
		expect(cfg.autoClose).toBe(false);
		expect(cfg.maxPerDrain).toBe(20);
	});
});

describe("loadSinksConfig", () => {
	it("returns null for a missing file", () => {
		expect(
			loadSinksConfig(join(tmpdir(), "nope", "lifecycle.config.json")),
		).toBeNull();
	});

	it("loads a valid config and rejects a malformed repo", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-"));
		try {
			const good = join(dir, "good.json");
			writeFileSync(
				good,
				JSON.stringify({
					sinks: { github: { enabled: true, repo: "owner/repo" } },
				}),
			);
			expect(loadSinksConfig(good)?.sinks.github?.repo).toBe("owner/repo");

			const bad = join(dir, "bad.json");
			writeFileSync(
				bad,
				JSON.stringify({
					sinks: {
						github: { enabled: true, repo: "https://github.com/owner/repo" },
					},
				}),
			);
			expect(() => loadSinksConfig(bad)).toThrow(/owner\/name/);

			const junk = join(dir, "junk.json");
			writeFileSync(junk, "{not json");
			expect(() => loadSinksConfig(junk)).toThrow(/JSON/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("severityRank", () => {
	it("orders critical > warning > info > unknown", () => {
		expect(severityRank("critical")).toBeGreaterThan(severityRank("warning"));
		expect(severityRank("warning")).toBeGreaterThan(severityRank("info"));
		expect(severityRank("info")).toBeGreaterThan(severityRank("weird"));
	});
});
