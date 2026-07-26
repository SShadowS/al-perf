import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import { resolve } from "path";
import { SourceIndexCache } from "../../src/source/cache.js";

const fixturesDir = resolve(import.meta.dir, "../fixtures/source");
const cacheDir = resolve(import.meta.dir, "../fixtures/.cache-test");

describe("SourceIndexCache", () => {
	beforeEach(() => {
		if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true });
	});

	test("cold cache builds index and stores it", async () => {
		const cache = new SourceIndexCache(cacheDir);
		const index = await cache.getOrBuild(fixturesDir);
		expect(index.files.length).toBe(43);
		expect(index.objects.size).toBe(43);
		expect(cache.has(fixturesDir)).toBe(true);
	});

	test("warm cache returns same index without re-parsing", async () => {
		const cache = new SourceIndexCache(cacheDir);
		const first = await cache.getOrBuild(fixturesDir);
		const second = await cache.getOrBuild(fixturesDir);
		expect(second.files.length).toBe(first.files.length);
		expect(second.objects.size).toBe(first.objects.size);
	});

	test("invalidate clears cache for directory", async () => {
		const cache = new SourceIndexCache(cacheDir);
		await cache.getOrBuild(fixturesDir);
		expect(cache.has(fixturesDir)).toBe(true);
		cache.invalidate(fixturesDir);
		expect(cache.has(fixturesDir)).toBe(false);
	});

	test("clearAll removes all cached entries", async () => {
		const cache = new SourceIndexCache(cacheDir);
		await cache.getOrBuild(fixturesDir);
		cache.clearAll();
		expect(cache.has(fixturesDir)).toBe(false);
	});

	test("a warm cache rebuilds the resolved table picture", async () => {
		// `tables` is derived and never serialized, so a cache hit must rebuild
		// it with the same builder — otherwise a cached run and a fresh run
		// disagree on identical source.
		const cache = new SourceIndexCache(cacheDir);
		const cold = await cache.getOrBuild(fixturesDir);
		const warm = await cache.getOrBuild(fixturesDir);
		expect(warm.tables.size).toBe(cold.tables.size);
		const t = warm.tables.get("merge base")!;
		expect(t).toBeDefined();
		expect(t.rootSeen).toBe(true);
		expect(t.fields.map((f) => f.name)).toContain("Ext Code");
		expect(t.keys.filter((k) => k.key.name === "ByDate")).toHaveLength(2);
	});

	test("rejects a cache written before extendsTarget existed", async () => {
		// `extendsTarget` is a NEW serialized ObjectInfo field. A pre-change
		// cache passes its dir hash unchanged, deserializes objects without it,
		// and rebuilds an empty merge — a cached run silently disagreeing with
		// a fresh one. Only the version guard catches that.
		const cache = new SourceIndexCache(cacheDir);
		await cache.getOrBuild(fixturesDir);
		expect(cache.has(fixturesDir)).toBe(true);

		const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const p = resolve(cacheDir, f);
			const entry = JSON.parse(readFileSync(p, "utf-8"));
			entry.version = 3;
			writeFileSync(p, JSON.stringify(entry), "utf-8");
		}
		expect(cache.has(fixturesDir)).toBe(false);
	});
});
