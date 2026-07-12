/**
 * config.test.ts — sink config loading, defaults (digest-first: autoFile and
 * autoClose OFF), validation, severity ranking.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	AZURE_DEVOPS_SINK_DEFAULTS,
	loadSinksConfig,
	resolveAzureDevOpsConfig,
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

	it("reopenOnRecurrence is OFF by default (comment-recurred-only stays today's behavior)", () => {
		expect(SINK_DEFAULTS.reopenOnRecurrence).toBe(false);
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

	// Pins the exact resolved shape byte-for-byte — the compat guard for the
	// SinkTriggerConfig extraction (Task 1 of the multi-sink-ado plan): the
	// azureDevOps block must not change what a github-only config resolves to.
	it("resolves a github-only config to the exact same shape as before the SinkTriggerConfig extraction", () => {
		const cfg = resolveGitHubConfig({ enabled: true, repo: "owner/repo" });
		expect(cfg).toEqual({
			enabled: true,
			repo: "owner/repo",
			tokenEnv: "GITHUB_TOKEN",
			autoFile: false,
			autoFileMinSeverity: "critical",
			autoFileAfterRuns: 2,
			autoClose: false,
			reopenOnRecurrence: false,
			labels: ["al-perf"],
			labelsAllowList: ["al-perf", "performance", "regression"],
			minMillisBetweenCalls: 1000,
			maxPerDrain: 20,
			collapseThreshold: 5,
		});
	});
});

describe("AZURE_DEVOPS_SINK_DEFAULTS", () => {
	it("is digest-first, same as github: autoFile and autoClose OFF by default", () => {
		expect(AZURE_DEVOPS_SINK_DEFAULTS.autoFile).toBe(false);
		expect(AZURE_DEVOPS_SINK_DEFAULTS.autoClose).toBe(false);
		expect(AZURE_DEVOPS_SINK_DEFAULTS.autoFileAfterRuns).toBe(2);
		expect(AZURE_DEVOPS_SINK_DEFAULTS.autoFileMinSeverity).toBe("critical");
		expect(AZURE_DEVOPS_SINK_DEFAULTS.reopenOnRecurrence).toBe(false);
	});

	it("has azure-devops-specific destination defaults", () => {
		expect(AZURE_DEVOPS_SINK_DEFAULTS.tokenEnv).toBe("AZDO_PAT");
		expect(AZURE_DEVOPS_SINK_DEFAULTS.workItemType).toBe("Bug");
		expect(AZURE_DEVOPS_SINK_DEFAULTS.closedState).toBe("Closed");
		expect(AZURE_DEVOPS_SINK_DEFAULTS.reopenState).toBe("Active");
	});
});

describe("resolveAzureDevOpsConfig", () => {
	it("merges defaults under explicit values", () => {
		const cfg = resolveAzureDevOpsConfig({
			enabled: true,
			org: "myorg",
			project: "myproject",
			autoFile: true,
		});
		expect(cfg.autoFile).toBe(true);
		expect(cfg.autoClose).toBe(false);
		expect(cfg.workItemType).toBe("Bug");
		expect(cfg.closedState).toBe("Closed");
		expect(cfg.reopenState).toBe("Active");
		expect(cfg.tokenEnv).toBe("AZDO_PAT");
		expect(cfg.maxPerDrain).toBe(20);
	});

	it("leaves areaPath unset when not provided (no meaningful default)", () => {
		const cfg = resolveAzureDevOpsConfig({
			enabled: true,
			org: "myorg",
			project: "myproject",
		});
		expect(cfg.areaPath).toBeUndefined();
	});

	it("passes an explicit areaPath through", () => {
		const cfg = resolveAzureDevOpsConfig({
			enabled: true,
			org: "myorg",
			project: "myproject",
			areaPath: "MyProject\\Perf",
		});
		expect(cfg.areaPath).toBe("MyProject\\Perf");
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

	it("rejects a quoted boolean naming reopenOnRecurrence (same quoted-boolean trap as the other trust-posture flags)", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-shape-"));
		try {
			const file = join(dir, "quoted-bool-reopen.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						github: {
							enabled: true,
							repo: "owner/repo",
							reopenOnRecurrence: "true",
						},
					},
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(/reopenOnRecurrence/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null for a file with no sinks key at all (telemetry-only/captureRequests-only config is legal — telemetry-recipe §10/§11)", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-shape-"));
		try {
			const file = join(dir, "no-sinks.json");
			writeFileSync(file, JSON.stringify({}));
			expect(loadSinksConfig(file)).toBeNull();

			const telemetryOnly = join(dir, "telemetry-only.json");
			writeFileSync(
				telemetryOnly,
				JSON.stringify({ telemetry: { maxSignalsPerBatch: 500 } }),
			);
			expect(loadSinksConfig(telemetryOnly)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still throws when sinks IS present but the wrong type", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-shape-"));
		try {
			const file = join(dir, "sinks-wrong-type.json");
			writeFileSync(file, JSON.stringify({ sinks: "nope" }));
			expect(() => loadSinksConfig(file)).toThrow(/sinks must be an object/);
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
							reopenOnRecurrence: true,
						},
					},
				}),
			);
			const cfg = loadSinksConfig(file);
			expect(cfg?.sinks.github?.autoFile).toBe(true);
			expect(cfg?.sinks.github?.autoFileMinSeverity).toBe("warning");
			expect(cfg?.sinks.github?.reopenOnRecurrence).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("loadSinksConfig — azureDevOps block", () => {
	it("loads an azureDevOps-only config", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-ado-"));
		try {
			const file = join(dir, "ado-only.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						azureDevOps: {
							enabled: true,
							org: "myorg",
							project: "myproject",
						},
					},
				}),
			);
			const cfg = loadSinksConfig(file);
			expect(cfg?.sinks.azureDevOps?.org).toBe("myorg");
			expect(cfg?.sinks.azureDevOps?.project).toBe("myproject");
			expect(cfg?.sinks.github).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads a config with both github and azureDevOps present", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-both-"));
		try {
			const file = join(dir, "both.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						github: { enabled: true, repo: "owner/repo" },
						azureDevOps: { enabled: true, org: "myorg", project: "myproject" },
					},
				}),
			);
			const cfg = loadSinksConfig(file);
			expect(cfg?.sinks.github?.repo).toBe("owner/repo");
			expect(cfg?.sinks.azureDevOps?.org).toBe("myorg");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a missing org, naming sinks.azureDevOps.org", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-ado-"));
		try {
			const file = join(dir, "no-org.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: { azureDevOps: { enabled: true, project: "myproject" } },
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(/sinks\.azureDevOps\.org/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects an empty-string project, naming sinks.azureDevOps.project", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-ado-"));
		try {
			const file = join(dir, "empty-project.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: { azureDevOps: { enabled: true, org: "myorg", project: "  " } },
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(
				/sinks\.azureDevOps\.project/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects an empty-string workItemType when present", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-ado-"));
		try {
			const file = join(dir, "empty-witype.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						azureDevOps: {
							enabled: true,
							org: "myorg",
							project: "myproject",
							workItemType: "",
						},
					},
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(
				/sinks\.azureDevOps\.workItemType/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects an empty-string closedState/reopenState when present", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-ado-"));
		try {
			const file = join(dir, "empty-closedstate.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						azureDevOps: {
							enabled: true,
							org: "myorg",
							project: "myproject",
							closedState: "",
						},
					},
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(
				/sinks\.azureDevOps\.closedState/,
			);

			const file2 = join(dir, "empty-reopenstate.json");
			writeFileSync(
				file2,
				JSON.stringify({
					sinks: {
						azureDevOps: {
							enabled: true,
							org: "myorg",
							project: "myproject",
							reopenState: "",
						},
					},
				}),
			);
			expect(() => loadSinksConfig(file2)).toThrow(
				/sinks\.azureDevOps\.reopenState/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects tags that aren't an array of strings", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-ado-"));
		try {
			const file = join(dir, "bad-tags.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						azureDevOps: {
							enabled: true,
							org: "myorg",
							project: "myproject",
							tags: "not-an-array",
						},
					},
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(/sinks\.azureDevOps\.tags/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a tagsAllowList with a non-string entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-ado-"));
		try {
			const file = join(dir, "bad-tagsallowlist.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						azureDevOps: {
							enabled: true,
							org: "myorg",
							project: "myproject",
							tagsAllowList: ["ok", 5],
						},
					},
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(
				/sinks\.azureDevOps\.tagsAllowList/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a quoted boolean on a shared trigger field under azureDevOps (same trap as github)", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-ado-"));
		try {
			const file = join(dir, "quoted-bool-ado.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						azureDevOps: {
							enabled: true,
							org: "myorg",
							project: "myproject",
							autoFile: "false",
						},
					},
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(/sinks\.azureDevOps\.autoFile/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects an invalid autoFileMinSeverity literal under azureDevOps", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-ado-"));
		try {
			const file = join(dir, "bad-severity-ado.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						azureDevOps: {
							enabled: true,
							org: "myorg",
							project: "myproject",
							autoFileMinSeverity: "urgent",
						},
					},
				}),
			);
			expect(() => loadSinksConfig(file)).toThrow(
				/sinks\.azureDevOps\.autoFileMinSeverity/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects sinks.azureDevOps when it isn't an object", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-ado-"));
		try {
			const file = join(dir, "ado-wrong-type.json");
			writeFileSync(file, JSON.stringify({ sinks: { azureDevOps: "nope" } }));
			expect(() => loadSinksConfig(file)).toThrow(
				/sinks\.azureDevOps must be an object/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still loads a fully-populated, correctly-typed azureDevOps config", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-ado-"));
		try {
			const file = join(dir, "valid-ado.json");
			writeFileSync(
				file,
				JSON.stringify({
					sinks: {
						azureDevOps: {
							enabled: true,
							org: "myorg",
							project: "myproject",
							tokenEnv: "MY_PAT",
							workItemType: "Bug",
							areaPath: "MyProject\\Perf",
							tags: ["al-perf"],
							tagsAllowList: ["al-perf", "performance"],
							closedState: "Done",
							reopenState: "To Do",
							autoFile: true,
							autoClose: false,
							autoFileMinSeverity: "warning",
							autoFileAfterRuns: 3,
							minMillisBetweenCalls: 2000,
							maxPerDrain: 10,
							collapseThreshold: 4,
							reopenOnRecurrence: true,
						},
					},
				}),
			);
			const cfg = loadSinksConfig(file);
			expect(cfg?.sinks.azureDevOps?.workItemType).toBe("Bug");
			expect(cfg?.sinks.azureDevOps?.closedState).toBe("Done");
			expect(cfg?.sinks.azureDevOps?.reopenState).toBe("To Do");
			expect(cfg?.sinks.azureDevOps?.tags).toEqual(["al-perf"]);
			expect(cfg?.sinks.azureDevOps?.reopenOnRecurrence).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("loadSinksConfig — {sinks:{}} graceful skip (both sinks absent)", () => {
	it("returns both sinks.github and sinks.azureDevOps undefined, the shape downstream code treats as no delivery configured", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-sink-cfg-empty-"));
		try {
			const file = join(dir, "empty-sinks.json");
			writeFileSync(file, JSON.stringify({ sinks: {} }));
			const cfg = loadSinksConfig(file);
			expect(cfg?.sinks.github).toBeUndefined();
			expect(cfg?.sinks.azureDevOps).toBeUndefined();
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
