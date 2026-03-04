import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { existsSync, rmSync } from "fs";
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
    expect(index.files.length).toBe(8);
    expect(index.objects.size).toBe(8);
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
});
