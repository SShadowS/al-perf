import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
	test,
} from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyzeProfile } from "../../src/core/analyzer.js";
import { HistoryStore } from "../../src/history/store.js";

const FIXTURES = resolve(import.meta.dir, "../fixtures");
const historyDir = resolve(import.meta.dir, "../fixtures/.history-test");

describe("HistoryStore", () => {
	beforeEach(() => {
		if (existsSync(historyDir)) rmSync(historyDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(historyDir)) rmSync(historyDir, { recursive: true });
	});

	test("save and retrieve an analysis result", async () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const entry = store.save(result, { label: "baseline" });

		expect(entry.id).toBeDefined();
		expect(entry.profileType).toBe("sampling");
		expect(entry.label).toBe("baseline");
		expect(entry.metrics.totalDuration).toBeGreaterThan(0);
		expect(entry.topHotspots.length).toBeGreaterThan(0);

		// Retrieve by ID
		const retrieved = store.get(entry.id);
		expect(retrieved).not.toBeNull();
		expect(retrieved!.id).toBe(entry.id);
		store.close();
	});

	test("save with gitCommit option", async () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const entry = store.save(result, { gitCommit: "abc1234", label: "test" });

		expect(entry.gitCommit).toBe("abc1234");

		const retrieved = store.get(entry.id);
		expect(retrieved!.gitCommit).toBe("abc1234");
		store.close();
	});

	test("query with filters", async () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		store.save(result, { label: "baseline" });
		store.save(result, { label: "optimized" });

		const all = store.query();
		expect(all).toHaveLength(2);

		const baselineOnly = store.query({ label: "baseline" });
		expect(baselineOnly).toHaveLength(1);
		expect(baselineOnly[0].label).toBe("baseline");

		const limited = store.query({ limit: 1 });
		expect(limited).toHaveLength(1);
		store.close();
	});

	test("delete and clearAll", async () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const entry = store.save(result);

		expect(store.count()).toBe(1);

		store.delete(entry.id);
		expect(store.count()).toBe(0);

		store.save(result);
		store.save(result);
		expect(store.count()).toBe(2);

		store.clearAll();
		expect(store.count()).toBe(0);
		store.close();
	});

	test("query by profilePath substring", async () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		store.save(result);

		const found = store.query({ profilePath: "sampling-minimal" });
		expect(found).toHaveLength(1);

		const notFound = store.query({ profilePath: "nonexistent" });
		expect(notFound).toHaveLength(0);
		store.close();
	});

	test("query by date range", async () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		store.save(result);

		// The entry timestamp comes from analyzedAt - query with a range that includes it
		const all = store.query();
		expect(all).toHaveLength(1);

		const _ts = all[0].timestamp;

		// since before the entry
		const sinceBefore = store.query({ since: "2000-01-01T00:00:00.000Z" });
		expect(sinceBefore).toHaveLength(1);

		// since after the entry
		const sinceAfter = store.query({ since: "2099-01-01T00:00:00.000Z" });
		expect(sinceAfter).toHaveLength(0);

		// until after the entry
		const untilAfter = store.query({ until: "2099-01-01T00:00:00.000Z" });
		expect(untilAfter).toHaveLength(1);

		// until before the entry
		const untilBefore = store.query({ until: "2000-01-01T00:00:00.000Z" });
		expect(untilBefore).toHaveLength(0);
		store.close();
	});

	test("get returns null for nonexistent ID", () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		expect(store.get("nonexistent-id")).toBeNull();
		store.close();
	});

	test("delete returns false for nonexistent ID", () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		expect(store.delete("nonexistent-id")).toBe(false);
		store.close();
	});

	test("query returns empty array when store directory does not exist", () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		expect(store.query()).toEqual([]);
		store.close();
	});

	test("count returns 0 when store directory does not exist", () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		expect(store.count()).toBe(0);
		store.close();
	});

	test("handles duplicate timestamps by appending counter", async () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);

		// Save twice with the same result (same timestamp and profilePath -> same base ID)
		const entry1 = store.save(result);
		const entry2 = store.save(result);

		expect(entry1.id).not.toBe(entry2.id);
		expect(store.count()).toBe(2);

		// Both should be retrievable
		expect(store.get(entry1.id)).not.toBeNull();
		expect(store.get(entry2.id)).not.toBeNull();
		store.close();
	});

	test("metrics snapshot captures expected fields", async () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const entry = store.save(result);

		expect(entry.metrics.totalDuration).toBe(result.meta.totalDuration);
		expect(entry.metrics.totalSelfTime).toBe(result.meta.totalSelfTime);
		expect(entry.metrics.idleSelfTime).toBe(result.meta.idleSelfTime);
		expect(entry.metrics.nodeCount).toBe(result.meta.totalNodes);
		expect(entry.metrics.maxDepth).toBe(result.meta.maxDepth);
		expect(entry.metrics.confidenceScore).toBe(result.meta.confidenceScore);
		expect(entry.metrics.healthScore).toBe(result.summary.healthScore);
		expect(entry.metrics.patternCount).toEqual(result.summary.patternCount);
		store.close();
	});

	test("topHotspots limited to 5", async () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);
		const result = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const entry = store.save(result);

		expect(entry.topHotspots.length).toBeLessThanOrEqual(5);
		// Each hotspot has the expected shape
		for (const h of entry.topHotspots) {
			expect(h.functionName).toBeDefined();
			expect(h.objectType).toBeDefined();
			expect(typeof h.objectId).toBe("number");
			expect(typeof h.selfTime).toBe("number");
			expect(typeof h.selfTimePercent).toBe("number");
		}
		store.close();
	});

	test("entries are returned newest first", async () => {
		const dbPath = join(historyDir, "lifecycle.sqlite");
		const store = new HistoryStore(dbPath);

		// Use two different profiles so the timestamps differ
		const result1 = await analyzeProfile(
			`${FIXTURES}/sampling-minimal.alcpuprofile`,
		);
		const result2 = await analyzeProfile(
			`${FIXTURES}/instrumentation-minimal.alcpuprofile`,
		);

		store.save(result1);
		store.save(result2);

		const entries = store.query();
		expect(entries).toHaveLength(2);
		expect(entries[0].timestamp >= entries[1].timestamp).toBe(true);
		store.close();
	});
});

describe("HistoryStore legacy JSON migration", () => {
	const legacyEntry = {
		id: "2026-01-01T00-00-00-000Z_abcd1234",
		timestamp: "2026-01-01T00:00:00.000Z",
		profilePath: "/profiles/old.alcpuprofile",
		profileType: "sampling" as const,
		metrics: {
			totalDuration: 1000,
			totalSelfTime: 900,
			idleSelfTime: 0,
			nodeCount: 10,
			maxDepth: 3,
			confidenceScore: 90,
			healthScore: 80,
			patternCount: { critical: 0, warning: 1, info: 0 },
		},
		topHotspots: [],
	};

	it("imports legacy entries once, writes a tombstone, keeps the files", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-history-legacy-"));
		try {
			const legacy = join(dir, ".al-perf-history");
			mkdirSync(legacy, { recursive: true });
			const jsonFile = join(legacy, `${legacyEntry.id}.json`);
			writeFileSync(jsonFile, JSON.stringify(legacyEntry));
			const dbPath = join(dir, "lifecycle.sqlite");

			const store = new HistoryStore(dbPath, { legacyDir: legacy });
			expect(store.count()).toBe(1);
			expect(store.get(legacyEntry.id)?.profilePath).toBe(
				legacyEntry.profilePath,
			);
			expect(existsSync(join(legacy, "MIGRATED.md"))).toBe(true);
			expect(existsSync(jsonFile)).toBe(true); // originals kept
			store.close();

			// Tombstone prevents re-import (no duplicates on reopen).
			const again = new HistoryStore(dbPath, { legacyDir: legacy });
			expect(again.count()).toBe(1);
			again.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not write a tombstone when the legacy dir has no JSON files", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-history-legacy-empty-"));
		try {
			const legacy = join(dir, ".al-perf-history");
			mkdirSync(legacy, { recursive: true });
			const dbPath = join(dir, "lifecycle.sqlite");

			const store = new HistoryStore(dbPath, { legacyDir: legacy });
			expect(store.count()).toBe(0);
			expect(existsSync(join(legacy, "MIGRATED.md"))).toBe(false);
			store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("imports valid entries and skips corrupt ones with a warning, never throws", () => {
		const dir = mkdtempSync(join(tmpdir(), "alperf-history-legacy-corrupt-"));
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const legacy = join(dir, ".al-perf-history");
			mkdirSync(legacy, { recursive: true });
			writeFileSync(
				join(legacy, `${legacyEntry.id}.json`),
				JSON.stringify(legacyEntry),
			);
			writeFileSync(join(legacy, "corrupt.json"), "{ not valid json");
			const dbPath = join(dir, "lifecycle.sqlite");

			let store: HistoryStore | undefined;
			expect(() => {
				store = new HistoryStore(dbPath, { legacyDir: legacy });
			}).not.toThrow();

			expect(store!.count()).toBe(1);
			expect(store!.get(legacyEntry.id)?.profilePath).toBe(
				legacyEntry.profilePath,
			);
			expect(warnSpy).toHaveBeenCalled();
			store!.close();
		} finally {
			warnSpy.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
