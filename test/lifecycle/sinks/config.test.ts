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

describe("loadSinksConfig — shape validation (fail closed)", () => {
	it("rejects a quoted boolean (common JSON typo) naming the field", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-shape-"));
		try {
			const file = join(dir, "quoted-bool.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						github: { enabled: true, repo: "owner/repo", autoFile: "false" },
					},
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(/autoFile/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a missing sinks key with a clear error, not a downstream TypeError", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-shape-"));
		try {
			const file = join(dir, "no-sinks.json");
			writeFileSync(file, JSON.stringify({}));
			expect(() => loadSinksConfig(file)).toThrow(/sinks/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects an invalid autoFileMinSeverity literal", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-shape-"));
		try {
			const file = join(dir, "bad-severity.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						github: {
							enabled: true,
							repo: "owner/repo",
							autoFileMinSeverity: "urgent",
						},
					},
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(/autoFileMinSeverity/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a stringified rate/retry number", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-shape-"));
		try {
			const file = join(dir, "bad-number.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						github: {
							enabled: true,
							repo: "owner/repo",
							maxPerDrain: "20",
						},
					},
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(/maxPerDrain/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still loads a fully-populated, correctly-typed config", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-shape-"));
		try {
			const file = join(dir, "valid.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						github: {
							enabled: true,
							repo: "owner/repo",
							autoFile: true,
							autoClose: false,
							autoFileMinSeverity: "warning",
							autoFileAfterRuns: 3,
							minMillisBetweenCalls: 2000,
							maxPerDrain: 10,
							collapseThreshold: 4,
						},
					},
				}),
			);
			const cfg = loadSinksConfig(file);
			expect(cfg?.sinks.github?.autoFile).toBe(true);
			expect(cfg?.sinks.github?.autoFileMinSeverity).toBe("warning");
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
