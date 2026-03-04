import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { existsSync, rmSync } from "fs";
import { HistoryStore } from "../../src/history/store.js";
import { analyzeProfile } from "../../src/core/analyzer.js";

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
    const store = new HistoryStore(historyDir);
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
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
  });

  test("save with gitCommit option", async () => {
    const store = new HistoryStore(historyDir);
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const entry = store.save(result, { gitCommit: "abc1234", label: "test" });

    expect(entry.gitCommit).toBe("abc1234");

    const retrieved = store.get(entry.id);
    expect(retrieved!.gitCommit).toBe("abc1234");
  });

  test("query with filters", async () => {
    const store = new HistoryStore(historyDir);
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    store.save(result, { label: "baseline" });
    store.save(result, { label: "optimized" });

    const all = store.query();
    expect(all).toHaveLength(2);

    const baselineOnly = store.query({ label: "baseline" });
    expect(baselineOnly).toHaveLength(1);
    expect(baselineOnly[0].label).toBe("baseline");

    const limited = store.query({ limit: 1 });
    expect(limited).toHaveLength(1);
  });

  test("delete and clearAll", async () => {
    const store = new HistoryStore(historyDir);
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const entry = store.save(result);

    expect(store.count()).toBe(1);

    store.delete(entry.id);
    expect(store.count()).toBe(0);

    store.save(result);
    store.save(result);
    expect(store.count()).toBe(2);

    store.clearAll();
    expect(store.count()).toBe(0);
  });

  test("query by profilePath substring", async () => {
    const store = new HistoryStore(historyDir);
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    store.save(result);

    const found = store.query({ profilePath: "sampling-minimal" });
    expect(found).toHaveLength(1);

    const notFound = store.query({ profilePath: "nonexistent" });
    expect(notFound).toHaveLength(0);
  });

  test("query by date range", async () => {
    const store = new HistoryStore(historyDir);
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    store.save(result);

    // The entry timestamp comes from analyzedAt - query with a range that includes it
    const all = store.query();
    expect(all).toHaveLength(1);

    const ts = all[0].timestamp;

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
  });

  test("get returns null for nonexistent ID", () => {
    const store = new HistoryStore(historyDir);
    expect(store.get("nonexistent-id")).toBeNull();
  });

  test("delete returns false for nonexistent ID", () => {
    const store = new HistoryStore(historyDir);
    expect(store.delete("nonexistent-id")).toBe(false);
  });

  test("query returns empty array when store directory does not exist", () => {
    const store = new HistoryStore(historyDir);
    expect(store.query()).toEqual([]);
  });

  test("count returns 0 when store directory does not exist", () => {
    const store = new HistoryStore(historyDir);
    expect(store.count()).toBe(0);
  });

  test("handles duplicate timestamps by appending counter", async () => {
    const store = new HistoryStore(historyDir);
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);

    // Save twice with the same result (same timestamp and profilePath -> same base ID)
    const entry1 = store.save(result);
    const entry2 = store.save(result);

    expect(entry1.id).not.toBe(entry2.id);
    expect(store.count()).toBe(2);

    // Both should be retrievable
    expect(store.get(entry1.id)).not.toBeNull();
    expect(store.get(entry2.id)).not.toBeNull();
  });

  test("metrics snapshot captures expected fields", async () => {
    const store = new HistoryStore(historyDir);
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const entry = store.save(result);

    expect(entry.metrics.totalDuration).toBe(result.meta.totalDuration);
    expect(entry.metrics.totalSelfTime).toBe(result.meta.totalSelfTime);
    expect(entry.metrics.idleSelfTime).toBe(result.meta.idleSelfTime);
    expect(entry.metrics.nodeCount).toBe(result.meta.totalNodes);
    expect(entry.metrics.maxDepth).toBe(result.meta.maxDepth);
    expect(entry.metrics.confidenceScore).toBe(result.meta.confidenceScore);
    expect(entry.metrics.healthScore).toBe(result.summary.healthScore);
    expect(entry.metrics.patternCount).toEqual(result.summary.patternCount);
  });

  test("topHotspots limited to 5", async () => {
    const store = new HistoryStore(historyDir);
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
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
  });

  test("entries are returned newest first", async () => {
    const store = new HistoryStore(historyDir);

    // Use two different profiles so the timestamps differ
    const result1 = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const result2 = await analyzeProfile(`${FIXTURES}/instrumentation-minimal.alcpuprofile`);

    store.save(result1);
    store.save(result2);

    const entries = store.query();
    expect(entries).toHaveLength(2);
    // Files are sorted reverse-alphabetically, which corresponds to newest first
    // since filenames start with timestamps
    expect(entries[0].timestamp >= entries[1].timestamp).toBe(true);
  });
});
