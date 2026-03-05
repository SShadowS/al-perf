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
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
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

  test("computes wallClockTime and gapTime for instrumentation profiles", async () => {
    const parsed = await parseProfile(`${FIXTURES}/instrumentation-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    const onRun = methods.find(m => m.functionName === "OnRun")!;
    // OnRun: nodeStartTime=63791355211203262, nodeEndTime=63791355211703262
    // wallClockTime = 500000, totalTime = 850000 (500000 self + 350000 child)
    // Since totalTime > wallClockTime here, gapTime should be 0
    expect(onRun.wallClockTime).toBeDefined();
    expect(onRun.wallClockTime).toBe(500000);
    expect(onRun.gapTime).toBe(0);

    const processLine = methods.find(m => m.functionName === "ProcessLine")!;
    // ProcessLine: wallClockTime = 350000, totalTime = 350000 => gapTime = 0
    expect(processLine.wallClockTime).toBe(350000);
    expect(processLine.gapTime).toBe(0);
  });

  test("sets isBuiltin flag on method breakdown", async () => {
    const parsed = await parseProfile(`${FIXTURES}/instrumentation-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);
    // All methods in instrumentation-minimal have isBuiltinCodeUnitCall: false
    for (const m of methods) {
      expect(m.isBuiltin).toBe(false);
    }
  });

  test("aggregates line-level hotspots from positionTicks", async () => {
    const parsed = await parseProfile(`${FIXTURES}/instrumentation-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    const processLine = methods.find(m => m.functionName === "ProcessLine")!;
    // ProcessLine has positionTicks: [{line:25, executionTime:200000}, {line:30, executionTime:150000}]
    expect(processLine.lineHotspots).toBeDefined();
    expect(processLine.lineHotspots).toHaveLength(2);
    expect(processLine.lineHotspots![0].line).toBe(25);
    expect(processLine.lineHotspots![0].executionTime).toBe(200000);
    expect(processLine.lineHotspots![1].line).toBe(30);
    expect(processLine.lineHotspots![1].executionTime).toBe(150000);
  });

  test("computes costPerHit for each method", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    const processLine = methods.find(m => m.functionName === "ProcessLine")!;
    // With sample-based selfTime: selfTime=400000, hitCount=20 => costPerHit=20000
    expect(processLine.costPerHit).toBe(20000);

    const onRun = methods.find(m => m.functionName === "OnRun")!;
    // With sample-based selfTime: selfTime=0, hitCount=5 => costPerHit=0
    expect(onRun.costPerHit).toBe(0);
  });

  test("computes efficiencyScore for each method", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    const processLine = methods.find(m => m.functionName === "ProcessLine")!;
    // With sample-based selfTime: selfTime=400000, totalTime=400000 (leaf) => efficiencyScore=1.0
    expect(processLine.efficiencyScore).toBeCloseTo(1.0, 2);

    const onRun = methods.find(m => m.functionName === "OnRun")!;
    // With sample-based selfTime: selfTime=0, totalTime=400000 => efficiencyScore=0.0
    expect(onRun.efficiencyScore).toBeCloseTo(0.0, 2);
  });

  test("computes callAmplification from hitCount ratio", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    const processLine = methods.find(m => m.functionName === "ProcessLine")!;
    // ProcessLine hitCount=20, parent OnRun hitCount=5, ratio=4.0
    expect(processLine.callAmplification).toBeCloseTo(4.0, 1);

    const onRun = methods.find(m => m.functionName === "OnRun")!;
    // OnRun is a root, no parent => callAmplification should be undefined
    expect(onRun.callAmplification).toBeUndefined();
  });

  test("computes instanceStats for instrumentation profiles with multiple calls", async () => {
    const parsed = await parseProfile(`${FIXTURES}/instrumentation-multi-call.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    const processLine = methods.find(m => m.functionName === "ProcessLine")!;
    expect(processLine.instanceStats).toBeDefined();
    expect(processLine.instanceStats!.instanceCount).toBe(5);
    expect(processLine.instanceStats!.min).toBe(30000);
    expect(processLine.instanceStats!.max).toBe(300000);
    expect(processLine.instanceStats!.median).toBe(100000);
    expect(processLine.instanceStats!.mean).toBeCloseTo(136000, -2);
  });

  test("omits instanceStats for sampling profiles", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    for (const m of methods) {
      expect(m.instanceStats).toBeUndefined();
    }
  });

  test("wallClockTime is undefined for sampling profiles", async () => {
    const parsed = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const processed = processProfile(parsed);
    const methods = aggregateByMethod(processed);

    const onRun = methods.find(m => m.functionName === "OnRun")!;
    expect(onRun.wallClockTime).toBeUndefined();
    expect(onRun.gapTime).toBeUndefined();
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
