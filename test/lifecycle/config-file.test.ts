/**
 * config-file.test.ts — mergeLifecycleConfig (pure deep merge) and
 * loadLifecycleConfigFile (fail-closed loader for the telemetry/
 * captureRequests blocks of .al-perf/lifecycle.config.json).
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/lifecycle/config.js";
import {
	loadLifecycleConfigFile,
	mergeLifecycleConfig,
} from "../../src/lifecycle/config-file.js";

function withTmpDir(prefix: string, fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("mergeLifecycleConfig", () => {
	it("KILL-SWITCH: a patch containing only one severity key never resets maxSignalsPerBatch or other severity keys", () => {
		const merged = mergeLifecycleConfig(DEFAULT_LIFECYCLE_CONFIG, {
			telemetry: {
				severity: {
					RT0018: { warningMs: 60_000, criticalMs: 600_000 },
				},
			},
		});

		expect(merged.telemetry.maxSignalsPerBatch).toBe(10_000);
		expect(merged.telemetry.severity.RT0005).toEqual(
			DEFAULT_LIFECYCLE_CONFIG.telemetry.severity.RT0005,
		);
		expect(merged.telemetry.severity.default).toEqual(
			DEFAULT_LIFECYCLE_CONFIG.telemetry.severity.default,
		);
		expect(merged.telemetry.severity.RT0018).toEqual({
			warningMs: 60_000,
			criticalMs: 600_000,
		});
	});

	it("replaces scalar telemetry fields", () => {
		const merged = mergeLifecycleConfig(DEFAULT_LIFECYCLE_CONFIG, {
			telemetry: { maxSignalsPerBatch: 500 },
		});
		expect(merged.telemetry.maxSignalsPerBatch).toBe(500);
		expect(merged.telemetry.severity).toEqual(
			DEFAULT_LIFECYCLE_CONFIG.telemetry.severity,
		);
	});

	it("replaces captureRequests fields individually, leaving the rest at defaults", () => {
		const merged = mergeLifecycleConfig(DEFAULT_LIFECYCLE_CONFIG, {
			captureRequests: { maxPending: 5 },
		});
		expect(merged.captureRequests.maxPending).toBe(5);
		expect(merged.captureRequests.enabled).toBe(
			DEFAULT_LIFECYCLE_CONFIG.captureRequests.enabled,
		);
		expect(merged.captureRequests.minOccurrences).toBe(
			DEFAULT_LIFECYCLE_CONFIG.captureRequests.minOccurrences,
		);
		expect(merged.captureRequests.minSeverity).toBe(
			DEFAULT_LIFECYCLE_CONFIG.captureRequests.minSeverity,
		);
		expect(merged.captureRequests.ttlDays).toBe(
			DEFAULT_LIFECYCLE_CONFIG.captureRequests.ttlDays,
		);
	});

	it("an empty patch produces a config deep-equal to the defaults", () => {
		const merged = mergeLifecycleConfig(DEFAULT_LIFECYCLE_CONFIG, {});
		expect(merged).toEqual(DEFAULT_LIFECYCLE_CONFIG);
	});

	it("adds a brand-new severity key alongside the existing default keys", () => {
		const merged = mergeLifecycleConfig(DEFAULT_LIFECYCLE_CONFIG, {
			telemetry: {
				severity: {
					"RT0018@Background": { warningMs: 20_000, criticalMs: 90_000 },
				},
			},
		});
		expect(merged.telemetry.severity["RT0018@Background"]).toEqual({
			warningMs: 20_000,
			criticalMs: 90_000,
		});
		expect(merged.telemetry.severity.RT0018).toEqual(
			DEFAULT_LIFECYCLE_CONFIG.telemetry.severity.RT0018,
		);
		expect(merged.telemetry.severity.RT0005).toEqual(
			DEFAULT_LIFECYCLE_CONFIG.telemetry.severity.RT0005,
		);
		expect(merged.telemetry.severity.default).toEqual(
			DEFAULT_LIFECYCLE_CONFIG.telemetry.severity.default,
		);
		expect(Object.keys(merged.telemetry.severity).sort()).toEqual(
			["RT0005", "RT0018", "RT0018@Background", "default"].sort(),
		);
	});

	it("never mutates the base config", () => {
		const before = JSON.parse(JSON.stringify(DEFAULT_LIFECYCLE_CONFIG));
		mergeLifecycleConfig(DEFAULT_LIFECYCLE_CONFIG, {
			telemetry: {
				maxSignalsPerBatch: 1,
				severity: { RT0018: { warningMs: 1, criticalMs: 2 } },
			},
			captureRequests: { maxPending: 1 },
		});
		expect(DEFAULT_LIFECYCLE_CONFIG).toEqual(before);
	});
});

describe("loadLifecycleConfigFile", () => {
	it("returns null for a missing file", () => {
		expect(
			loadLifecycleConfigFile(join(tmpdir(), "nope", "lifecycle.config.json")),
		).toBeNull();
	});

	it("throws naming the path on malformed JSON", () => {
		withTmpDir("alperf-lc-cfg-", (dir) => {
			const file = join(dir, "junk.json");
			writeFileSync(file, "{not json");
			expect(() => loadLifecycleConfigFile(file)).toThrow(/JSON/);
			expect(() => loadLifecycleConfigFile(file)).toThrow(
				new RegExp(file.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")),
			);
		});
	});

	it("throws when the root is not an object", () => {
		withTmpDir("alperf-lc-cfg-", (dir) => {
			const file = join(dir, "array-root.json");
			writeFileSync(file, JSON.stringify([1, 2, 3]));
			expect(() => loadLifecycleConfigFile(file)).toThrow(/root must be an object/);
		});
	});

	it("returns an empty patch for a file with only a sinks block (ignored here)", () => {
		withTmpDir("alperf-lc-cfg-", (dir) => {
			const file = join(dir, "sinks-only.json");
			writeFileSync(
				file,
				JSON.stringify({ sinks: { github: { enabled: true, repo: "owner/repo" } } }),
			);
			expect(loadLifecycleConfigFile(file)).toEqual({});
		});
	});

	describe("telemetry block validation", () => {
		it("rejects a non-integer maxSignalsPerBatch", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "bad-max.json");
				writeFileSync(
					file,
					JSON.stringify({ telemetry: { maxSignalsPerBatch: 10.5 } }),
				);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/maxSignalsPerBatch/);
			});
		});

		it("rejects a zero/negative maxSignalsPerBatch", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "zero-max.json");
				writeFileSync(file, JSON.stringify({ telemetry: { maxSignalsPerBatch: 0 } }));
				expect(() => loadLifecycleConfigFile(file)).toThrow(/maxSignalsPerBatch/);
			});
		});

		it("rejects a stringified maxSignalsPerBatch (quoted-number trap)", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "string-max.json");
				writeFileSync(file, JSON.stringify({ telemetry: { maxSignalsPerBatch: "500" } }));
				expect(() => loadLifecycleConfigFile(file)).toThrow(/maxSignalsPerBatch/);
			});
		});

		it("rejects an invalid severity key (whitespace/injection garbage)", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "bad-key.json");
				writeFileSync(
					file,
					JSON.stringify({
						telemetry: {
							severity: { "RT0018; DROP TABLE": { warningMs: 1, criticalMs: 2 } },
						},
					}),
				);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/RT0018; DROP TABLE/);
			});
		});

		for (const reservedKey of ["__proto__", "constructor", "prototype"]) {
			it(`rejects the reserved severity key "${reservedKey}", naming it`, () => {
				withTmpDir("alperf-lc-cfg-", (dir) => {
					const file = join(dir, "reserved-key.json");
					writeFileSync(
						file,
						JSON.stringify({
							telemetry: {
								severity: { [reservedKey]: { warningMs: 1, criticalMs: 2 } },
							},
						}),
					);
					expect(() => loadLifecycleConfigFile(file)).toThrow(
						new RegExp(`${reservedKey}.*reserved`),
					);
				});
			});
		}

		it("accepts the @clientType severity key convention", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "client-type-key.json");
				writeFileSync(
					file,
					JSON.stringify({
						telemetry: {
							severity: { "RT0018@Web": { warningMs: 1, criticalMs: 2 } },
						},
					}),
				);
				const patch = loadLifecycleConfigFile(file);
				expect(patch?.telemetry?.severity?.["RT0018@Web"]).toEqual({
					warningMs: 1,
					criticalMs: 2,
				});
			});
		});

		it("rejects a non-finite warningMs", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "nan-warning.json");
				writeFileSync(
					file,
					JSON.stringify({
						telemetry: { severity: { RT0018: { warningMs: null, criticalMs: 2 } } },
					}),
				);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/RT0018/);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/warningMs/);
			});
		});

		it("rejects a negative criticalMs", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "neg-critical.json");
				writeFileSync(
					file,
					JSON.stringify({
						telemetry: { severity: { RT0018: { warningMs: 1, criticalMs: -5 } } },
					}),
				);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/RT0018/);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/criticalMs/);
			});
		});

		it("rejects an Infinity warningMs (1e400 overflows to Infinity on JSON.parse)", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "infinite-warning.json");
				// JSON.stringify can't produce this literal (Infinity isn't valid
				// JSON), so the raw text is written directly: 1e400 is syntactically
				// a valid JSON number but overflows f64 range, parsing to Infinity.
				writeFileSync(
					file,
					'{"telemetry":{"severity":{"RT0018":{"warningMs":1e400,"criticalMs":2}}}}',
				);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/RT0018/);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/warningMs/);
			});
		});

		it("rejects an Infinity criticalMs (1e400 overflows to Infinity on JSON.parse)", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "infinite-critical.json");
				writeFileSync(
					file,
					'{"telemetry":{"severity":{"RT0018":{"warningMs":1,"criticalMs":1e400}}}}',
				);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/RT0018/);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/criticalMs/);
			});
		});

		it("rejects warningMs > criticalMs, naming the key", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "inverted.json");
				writeFileSync(
					file,
					JSON.stringify({
						telemetry: {
							severity: { RT0018: { warningMs: 100, criticalMs: 50 } },
						},
					}),
				);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/RT0018/);
			});
		});

		it("allows warningMs === criticalMs", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "equal.json");
				writeFileSync(
					file,
					JSON.stringify({
						telemetry: { severity: { RT0018: { warningMs: 50, criticalMs: 50 } } },
					}),
				);
				const patch = loadLifecycleConfigFile(file);
				expect(patch?.telemetry?.severity?.RT0018).toEqual({
					warningMs: 50,
					criticalMs: 50,
				});
			});
		});

		it("ignores unknown keys inside the telemetry block", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "unknown-telemetry-key.json");
				writeFileSync(
					file,
					JSON.stringify({
						telemetry: { maxSignalsPerBatch: 500, somethingFuture: true },
					}),
				);
				const patch = loadLifecycleConfigFile(file);
				expect(patch).toEqual({ telemetry: { maxSignalsPerBatch: 500 } });
			});
		});
	});

	describe("captureRequests block validation", () => {
		it("rejects a quoted boolean for enabled (the quoted-boolean trap)", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "quoted-bool.json");
				writeFileSync(file, JSON.stringify({ captureRequests: { enabled: "false" } }));
				expect(() => loadLifecycleConfigFile(file)).toThrow(/enabled/);
			});
		});

		it("rejects a non-positive-integer minOccurrences", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "bad-min-occ.json");
				writeFileSync(file, JSON.stringify({ captureRequests: { minOccurrences: -1 } }));
				expect(() => loadLifecycleConfigFile(file)).toThrow(/minOccurrences/);
			});
		});

		it("rejects a non-positive-integer ttlDays", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "bad-ttl.json");
				writeFileSync(file, JSON.stringify({ captureRequests: { ttlDays: 0 } }));
				expect(() => loadLifecycleConfigFile(file)).toThrow(/ttlDays/);
			});
		});

		it("rejects a non-positive-integer maxPending", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "bad-max-pending.json");
				writeFileSync(file, JSON.stringify({ captureRequests: { maxPending: 2.5 } }));
				expect(() => loadLifecycleConfigFile(file)).toThrow(/maxPending/);
			});
		});

		it("rejects an invalid minSeverity enum value", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "bad-min-severity.json");
				writeFileSync(
					file,
					JSON.stringify({ captureRequests: { minSeverity: "urgent" } }),
				);
				expect(() => loadLifecycleConfigFile(file)).toThrow(/minSeverity/);
			});
		});

		it("ignores unknown keys inside the captureRequests block", () => {
			withTmpDir("alperf-lc-cfg-", (dir) => {
				const file = join(dir, "unknown-cr-key.json");
				writeFileSync(
					file,
					JSON.stringify({ captureRequests: { maxPending: 5, somethingFuture: true } }),
				);
				const patch = loadLifecycleConfigFile(file);
				expect(patch).toEqual({ captureRequests: { maxPending: 5 } });
			});
		});
	});

	it("round-trips a full valid file", () => {
		withTmpDir("alperf-lc-cfg-", (dir) => {
			const file = join(dir, "valid.json");
			writeFileSync(
				file,
				JSON.stringify({
					telemetry: {
						maxSignalsPerBatch: 5000,
						severity: {
							RT0018: { warningMs: 5_000, criticalMs: 15_000 },
							"RT0018@Web": { warningMs: 8_000, criticalMs: 20_000 },
						},
					},
					captureRequests: {
						enabled: false,
						minOccurrences: 5,
						minSeverity: "critical",
						ttlDays: 7,
						maxPending: 10,
					},
					sinks: { github: { enabled: true, repo: "owner/repo" } },
				}),
			);
			const patch = loadLifecycleConfigFile(file);
			expect(patch).toEqual({
				telemetry: {
					maxSignalsPerBatch: 5000,
					severity: {
						RT0018: { warningMs: 5_000, criticalMs: 15_000 },
						"RT0018@Web": { warningMs: 8_000, criticalMs: 20_000 },
					},
				},
				captureRequests: {
					enabled: false,
					minOccurrences: 5,
					minSeverity: "critical",
					ttlDays: 7,
					maxPending: 10,
				},
			});
		});
	});
});
