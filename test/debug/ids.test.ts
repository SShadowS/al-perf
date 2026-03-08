import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { resolve } from "path";
import { initIdCounter, nextId } from "../../src/debug/ids.js";

const TEST_DIR = resolve(import.meta.dir, "..", "fixtures", "debug-ids-test");

describe("debug ID management", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("starts at 1 for empty directory", async () => {
    await initIdCounter(TEST_DIR);
    expect(nextId()).toBe(1);
  });

  test("continues from highest existing folder ID", async () => {
    await mkdir(resolve(TEST_DIR, "003_2026-03-08T19-30-45"), { recursive: true });
    await mkdir(resolve(TEST_DIR, "007_2026-03-08T20-00-00"), { recursive: true });
    await initIdCounter(TEST_DIR);
    expect(nextId()).toBe(8);
  });

  test("increments atomically", async () => {
    await initIdCounter(TEST_DIR);
    expect(nextId()).toBe(1);
    expect(nextId()).toBe(2);
    expect(nextId()).toBe(3);
  });

  test("ignores non-matching folder names", async () => {
    await mkdir(resolve(TEST_DIR, "not-a-debug-folder"), { recursive: true });
    await mkdir(resolve(TEST_DIR, "005_2026-03-08T19-30-45"), { recursive: true });
    await initIdCounter(TEST_DIR);
    expect(nextId()).toBe(6);
  });
});
