import { describe, it, expect } from "bun:test";
import { buildSourceIndex } from "../../../src/source/indexer.js";
import { resolve } from "path";

const fixturesSourceDir = resolve(import.meta.dir, "../../fixtures/source");

describe("source-map functionality", () => {
  it("should build source index with correct counts", async () => {
    const index = await buildSourceIndex(fixturesSourceDir);

    expect(index.files.length).toBe(10);
    expect(index.objects.size).toBe(10);

    let procedureCount = 0;
    let triggerCount = 0;
    for (const procs of index.procedures.values()) {
      procedureCount += procs.length;
    }
    for (const trigs of index.triggers.values()) {
      triggerCount += trigs.length;
    }

    expect(procedureCount).toBeGreaterThan(0);
    expect(triggerCount).toBeGreaterThan(0);
  });

  it("should include object details with procedures and triggers", async () => {
    const index = await buildSourceIndex(fixturesSourceDir);

    const cuObj = index.objects.get("Codeunit_50100");
    expect(cuObj).toBeDefined();
    expect(cuObj!.procedures.length).toBe(2);
    expect(cuObj!.triggers.length).toBe(1);

    const tableObj = index.objects.get("Table_50100");
    expect(tableObj).toBeDefined();
    expect(tableObj!.procedures.length).toBe(1);
    expect(tableObj!.triggers.length).toBe(2);
  });
});
