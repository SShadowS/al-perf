import { describe, expect, test, beforeEach } from "bun:test";
import { DebugStore } from "../../src/debug/store.js";
import type { DebugCapture } from "../../src/debug/types.js";

function makeCapture(id: number, token: string, timestamp?: Date): DebugCapture {
  return {
    id,
    token,
    timestamp: timestamp ?? new Date(),
    profileData: new Uint8Array(0),
    profileName: "test.alcpuprofile",
    costs: [],
    analysisDurationMs: 100,
  };
}

describe("DebugStore", () => {
  let store: DebugStore;

  beforeEach(() => {
    store = new DebugStore(60 * 60 * 1000);
  });

  test("stores and retrieves by token", () => {
    const capture = makeCapture(1, "abc-123");
    store.add(capture);
    expect(store.get("abc-123")).toBe(capture);
  });

  test("returns undefined for unknown token", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  test("remove deletes capture", () => {
    const capture = makeCapture(1, "abc-123");
    store.add(capture);
    store.remove("abc-123");
    expect(store.get("abc-123")).toBeUndefined();
  });

  test("pendingCount tracks active captures", () => {
    expect(store.pendingCount).toBe(0);
    store.add(makeCapture(1, "a"));
    store.add(makeCapture(2, "b"));
    expect(store.pendingCount).toBe(2);
    store.remove("a");
    expect(store.pendingCount).toBe(1);
  });

  test("sweep removes expired captures", () => {
    const oneHourAgo = new Date(Date.now() - 61 * 60 * 1000);
    store.add(makeCapture(1, "old", oneHourAgo));
    store.add(makeCapture(2, "new", new Date()));
    store.sweep();
    expect(store.get("old")).toBeUndefined();
    expect(store.get("new")).toBeDefined();
    expect(store.pendingCount).toBe(1);
  });
});
