import { describe, test, expect } from "bun:test";
import { parseProfile, detectProfileType } from "../../src/core/parser.js";
import type { ParsedProfile } from "../../src/types/profile.js";

const FIXTURES = "test/fixtures";

describe("detectProfileType", () => {
  test("detects sampling profile by kind field", () => {
    const raw = { kind: 1, nodes: [], startTime: 0, endTime: 0 } as any;
    expect(detectProfileType(raw)).toBe("sampling");
  });

  test("detects instrumentation profile by sampleExecutionTimes", () => {
    const raw = { nodes: [], startTime: 0, endTime: 0, sampleExecutionTimes: [] } as any;
    expect(detectProfileType(raw)).toBe("instrumentation");
  });

  test("detects instrumentation by positionTicks on first node", () => {
    const raw = {
      nodes: [{ id: 1, positionTicks: [], hitCount: 0, children: [], callFrame: {}, applicationDefinition: {}, frameIdentifier: 0 }],
      startTime: 0,
      endTime: 0,
    } as any;
    expect(detectProfileType(raw)).toBe("instrumentation");
  });
});

describe("parseProfile", () => {
  test("parses sampling profile from file", async () => {
    const result = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);

    expect(result.type).toBe("sampling");
    expect(result.nodes).toHaveLength(3);
    expect(result.nodeMap.size).toBe(3);
    expect(result.startTime).toBe(63793000000000000);
    expect(result.endTime).toBe(63793000003500000);
    expect(result.totalDuration).toBe(3500000);
  });

  test("parses instrumentation profile from file", async () => {
    const result = await parseProfile(`${FIXTURES}/instrumentation-minimal.alcpuprofile`);

    expect(result.type).toBe("instrumentation");
    expect(result.nodes).toHaveLength(2);
    expect(result.nodeMap.get(1)?.positionTicks).toHaveLength(1);
    expect(result.nodeMap.get(2)?.positionTicks).toHaveLength(2);
  });

  test("builds nodeMap keyed by node id", async () => {
    const result = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);

    expect(result.nodeMap.get(1)?.callFrame.functionName).toBe("OnRun");
    expect(result.nodeMap.get(2)?.callFrame.functionName).toBe("ProcessLine");
    expect(result.nodeMap.get(3)?.callFrame.functionName).toBe("IdleTime");
  });

  test("identifies root nodes (nodes not referenced as children)", async () => {
    const result = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);

    const rootIds = result.rootNodes.map(n => n.id).sort();
    expect(rootIds).toEqual([1, 3]);
  });

  test("calculates sampling interval from timeDeltas", async () => {
    const result = await parseProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);

    expect(result.samplingInterval).toBe(100000);
  });

  test("parses real sampling profile (Session6)", async () => {
    const result = await parseProfile("exampledata/PerformanceProfile_Session6.alcpuprofile");

    expect(result.type).toBe("sampling");
    expect(result.nodes.length).toBe(14);
    expect(result.nodeMap.get(1)?.callFrame.functionName).toBe("OnOpenPage");
  });

  test("parses real instrumentation profile", async () => {
    const result = await parseProfile("exampledata/cedf4512-490d-4252-b9f6-943dd571888f.alcpuprofile");

    expect(result.type).toBe("instrumentation");
    expect(result.nodes.length).toBeGreaterThan(2000);
  });

  test("throws on nonexistent file", async () => {
    expect(parseProfile("test/fixtures/nonexistent.alcpuprofile")).rejects.toThrow();
  });
});
