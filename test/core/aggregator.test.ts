import { describe, test, expect } from "bun:test";
import { parseProfile } from "../../src/core/parser.js";
import { processProfile } from "../../src/core/processor.js";
import { aggregateByApp, aggregateByObject, aggregateByMethod } from "../../src/core/aggregator.js";

const FIXTURES = "test/fixtures";

describe("aggregateByApp", () => {
  test("groups nodes by declaring application", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const apps = aggregateByApp(processed);

    const myApp = apps.find(a => a.appName === "My Extension");
    expect(myApp).toBeDefined();
    expect(myApp!.nodeCount).toBe(2);
  });

  test("sorts by selfTime descending", async () => {
    const parsed = await parseProfile("exampledata/PerformanceProfile_Session6.alcpuprofile");
    const processed = processProfile(parsed);
    const apps = aggregateByApp(processed);

    for (let i = 1; i < apps.length; i++) {
      expect(apps[i - 1].selfTime).toBeGreaterThanOrEqual(apps[i].selfTime);
    }
  });
});

describe("aggregateByMethod", () => {
  test("returns one entry per unique method+object combination", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    // IdleTime excluded, only OnRun and ProcessLine remain
    expect(methods).toHaveLength(2);
  });

  test("includes calledBy and calls relationships", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    const processLine = methods.find(m => m.functionName === "ProcessLine")!;
    expect(processLine.calledBy).toContain("OnRun (CodeUnit 50000)");

    const onRun = methods.find(m => m.functionName === "OnRun")!;
    expect(onRun.calls).toContain("ProcessLine (CodeUnit 50000)");
  });

  test("sorts by selfTime descending", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    for (let i = 1; i < methods.length; i++) {
      expect(methods[i - 1].selfTime).toBeGreaterThanOrEqual(methods[i].selfTime);
    }
  });
});

describe("aggregateByObject", () => {
  test("groups methods by object", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const objects = aggregateByObject(processed);

    const cu50000 = objects.find(o => o.objectId === 50000);
    expect(cu50000).toBeDefined();
    expect(cu50000!.methodCount).toBe(2);
  });
});
