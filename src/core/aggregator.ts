import type { ProcessedProfile } from "../types/processed.js";
import type { AppBreakdown, ObjectBreakdown, MethodBreakdown } from "../types/aggregated.js";
import { formatMethodRef } from "./patterns.js";
import { isIdleNode } from "./processor.js";

export function aggregateByApp(profile: ProcessedProfile): AppBreakdown[] {
  const map = new Map<string, AppBreakdown>();

  for (const node of profile.allNodes) {
    if (isIdleNode(node)) continue;
    const appName = node.declaringApplication?.appName ?? "(System)";
    const appPublisher = node.declaringApplication?.appPublisher ?? "";

    let entry = map.get(appName);
    if (!entry) {
      entry = {
        appName,
        appPublisher,
        selfTime: 0,
        selfTimePercent: 0,
        totalTime: 0,
        nodeCount: 0,
        methods: [],
      };
      map.set(appName, entry);
    }

    entry.selfTime += node.selfTime;
    entry.totalTime += node.totalTime;
    entry.nodeCount += 1;

    const methodName = node.callFrame.functionName;
    if (!entry.methods.includes(methodName)) {
      entry.methods.push(methodName);
    }
  }

  // Calculate percentages
  for (const entry of map.values()) {
    entry.selfTimePercent =
      profile.activeSelfTime > 0
        ? (entry.selfTime / profile.activeSelfTime) * 100
        : 0;
  }

  // Sort by selfTime descending
  return Array.from(map.values()).sort((a, b) => b.selfTime - a.selfTime);
}

export function aggregateByMethod(profile: ProcessedProfile): MethodBreakdown[] {
  const map = new Map<string, MethodBreakdown>();

  for (const node of profile.allNodes) {
    if (isIdleNode(node)) continue;
    const { functionName } = node.callFrame;
    const { objectType, objectName, objectId } = node.applicationDefinition;
    const key = `${functionName}_${objectType}_${objectId}`;
    const appName = node.declaringApplication?.appName ?? "(System)";

    let entry = map.get(key);
    if (!entry) {
      entry = {
        functionName,
        objectType,
        objectName,
        objectId,
        appName,
        selfTime: 0,
        selfTimePercent: 0,
        totalTime: 0,
        totalTimePercent: 0,
        hitCount: 0,
        calledBy: [],
        calls: [],
        isBuiltin: false,
        costPerHit: 0,
        efficiencyScore: 0,
      };
      map.set(key, entry);
    }

    entry.selfTime += node.selfTime;
    entry.totalTime += node.totalTime;
    entry.hitCount += node.hitCount;

    if (node.isBuiltinCodeUnitCall) {
      entry.isBuiltin = true;
    }

    // Track wall-clock time for instrumentation profiles (nodes with startTime/endTime)
    if (node.nodeStartTime !== undefined && node.nodeEndTime !== undefined) {
      const nodeDuration = node.nodeEndTime - node.nodeStartTime;
      entry.wallClockTime = (entry.wallClockTime ?? 0) + nodeDuration;
    }

    // Collect calledBy from parent
    if (node.parent) {
      const ref = formatMethodRef(node.parent);
      if (!entry.calledBy.includes(ref)) {
        entry.calledBy.push(ref);
      }
    }

    // Collect calls from children
    for (const child of node.children) {
      const ref = formatMethodRef(child);
      if (!entry.calls.includes(ref)) {
        entry.calls.push(ref);
      }
    }
  }

  // Calculate percentages
  for (const entry of map.values()) {
    entry.selfTimePercent =
      profile.activeSelfTime > 0
        ? (entry.selfTime / profile.activeSelfTime) * 100
        : 0;
    entry.totalTimePercent =
      profile.activeSelfTime > 0
        ? (entry.totalTime / profile.activeSelfTime) * 100
        : 0;
    entry.costPerHit = entry.hitCount > 0 ? entry.selfTime / entry.hitCount : 0;
    entry.efficiencyScore = entry.totalTime > 0 ? entry.selfTime / entry.totalTime : 0;
  }

  // Compute call amplification: max hitCount ratio vs parent
  for (const node of profile.allNodes) {
    if (isIdleNode(node) || !node.parent) continue;
    const { functionName } = node.callFrame;
    const { objectType, objectId } = node.applicationDefinition;
    const key = `${functionName}_${objectType}_${objectId}`;
    const entry = map.get(key);
    if (!entry || node.parent.hitCount === 0) continue;

    const ratio = node.hitCount / node.parent.hitCount;
    if (entry.callAmplification === undefined || ratio > entry.callAmplification) {
      entry.callAmplification = ratio;
    }
  }

  // Compute gapTime for methods with wallClockTime
  for (const entry of map.values()) {
    if (entry.wallClockTime !== undefined) {
      entry.gapTime = Math.max(0, entry.wallClockTime - entry.totalTime);
    }
  }

  // Aggregate line-level hotspots from positionTicks
  const lineMap = new Map<string, Map<number, number>>(); // methodKey -> (line -> executionTime)
  for (const node of profile.allNodes) {
    if (isIdleNode(node) || !node.positionTicks?.length) continue;
    const { functionName } = node.callFrame;
    const { objectType, objectId } = node.applicationDefinition;
    const key = `${functionName}_${objectType}_${objectId}`;

    let lines = lineMap.get(key);
    if (!lines) {
      lines = new Map();
      lineMap.set(key, lines);
    }
    for (const pt of node.positionTicks) {
      lines.set(pt.line, (lines.get(pt.line) ?? 0) + pt.executionTime);
    }
  }

  for (const [key, lines] of lineMap) {
    const entry = map.get(key);
    if (!entry) continue;
    const sorted = Array.from(lines.entries())
      .map(([line, executionTime]) => ({
        line,
        executionTime,
        executionTimePercent: entry.selfTime > 0 ? (executionTime / entry.selfTime) * 100 : 0,
      }))
      .sort((a, b) => b.executionTime - a.executionTime);
    entry.lineHotspots = sorted;
  }

  // Sort by selfTime descending
  return Array.from(map.values()).sort((a, b) => b.selfTime - a.selfTime);
}

export function aggregateByObject(profile: ProcessedProfile): ObjectBreakdown[] {
  const map = new Map<string, ObjectBreakdown>();

  // First get method breakdowns so we can attach them
  const allMethods = aggregateByMethod(profile);

  for (const method of allMethods) {
    const key = `${method.objectType}_${method.objectId}`;

    let entry = map.get(key);
    if (!entry) {
      entry = {
        objectType: method.objectType,
        objectName: method.objectName,
        objectId: method.objectId,
        appName: method.appName,
        selfTime: 0,
        selfTimePercent: 0,
        totalTime: 0,
        methodCount: 0,
        methods: [],
      };
      map.set(key, entry);
    }

    entry.selfTime += method.selfTime;
    entry.totalTime += method.totalTime;
    entry.methodCount += 1;
    entry.methods.push(method);
  }

  // Calculate percentages
  for (const entry of map.values()) {
    entry.selfTimePercent =
      profile.activeSelfTime > 0
        ? (entry.selfTime / profile.activeSelfTime) * 100
        : 0;
  }

  // Sort by selfTime descending
  return Array.from(map.values()).sort((a, b) => b.selfTime - a.selfTime);
}
