import type { ProcessedNode, ProcessedProfile } from "../types/processed.js";
import type { AppBreakdown, ObjectBreakdown, MethodBreakdown } from "../types/aggregated.js";

function formatMethodRef(node: ProcessedNode): string {
  const { functionName } = node.callFrame;
  const { objectType, objectId } = node.applicationDefinition;
  return `${functionName} (${objectType} ${objectId})`;
}

export function aggregateByApp(profile: ProcessedProfile): AppBreakdown[] {
  const map = new Map<string, AppBreakdown>();

  for (const node of profile.allNodes) {
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
      profile.totalSelfTime > 0
        ? (entry.selfTime / profile.totalSelfTime) * 100
        : 0;
  }

  // Sort by selfTime descending
  return Array.from(map.values()).sort((a, b) => b.selfTime - a.selfTime);
}

export function aggregateByMethod(profile: ProcessedProfile): MethodBreakdown[] {
  const map = new Map<string, MethodBreakdown>();

  for (const node of profile.allNodes) {
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
      };
      map.set(key, entry);
    }

    entry.selfTime += node.selfTime;
    entry.totalTime += node.totalTime;
    entry.hitCount += node.hitCount;

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
      profile.totalSelfTime > 0
        ? (entry.selfTime / profile.totalSelfTime) * 100
        : 0;
    entry.totalTimePercent =
      profile.totalSelfTime > 0
        ? (entry.totalTime / profile.totalSelfTime) * 100
        : 0;
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
      profile.totalSelfTime > 0
        ? (entry.selfTime / profile.totalSelfTime) * 100
        : 0;
  }

  // Sort by selfTime descending
  return Array.from(map.values()).sort((a, b) => b.selfTime - a.selfTime);
}
