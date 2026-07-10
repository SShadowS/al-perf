import type {
	ParsedProfile,
	ProfileType,
	RawProfile,
	RawProfileNode,
} from "../types/profile.js";
import { isIrJsonDocument, parseIrJson } from "./irjson-parser.js";

export function detectProfileType(raw: RawProfile): ProfileType {
	if (raw.kind === 1) return "sampling";
	if (raw.sampleExecutionTimes) return "instrumentation";
	if (raw.nodes?.length > 0 && raw.nodes[0].positionTicks)
		return "instrumentation";
	return "sampling";
}

export async function parseProfile(filePath: string): Promise<ParsedProfile> {
	const file = Bun.file(filePath);
	const text = await file.text();
	const raw = JSON.parse(text);
	// Content sniffing, not extension: ir-json carries a numeric top-level
	// schemaVersion + invocations[]; .alcpuprofile carries nodes[].
	if (isIrJsonDocument(raw)) {
		return parseIrJson(raw);
	}
	return parseProfileFromRaw(raw as RawProfile);
}

export function parseProfileFromRaw(raw: RawProfile): ParsedProfile {
	if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length === 0) {
		throw new Error("Invalid profile: missing or empty 'nodes' array");
	}
	if (typeof raw.startTime !== "number" || typeof raw.endTime !== "number") {
		throw new Error("Invalid profile: missing 'startTime' or 'endTime'");
	}

	const type = detectProfileType(raw);
	const nodeMap = new Map<number, RawProfileNode>();
	for (const node of raw.nodes) {
		nodeMap.set(node.id, node);
	}

	const childIds = new Set<number>();
	for (const node of raw.nodes) {
		for (const childId of node.children) {
			childIds.add(childId);
		}
	}
	const rootNodes = raw.nodes.filter((n) => !childIds.has(n.id));

	const totalDuration = raw.endTime - raw.startTime;

	let samplingInterval: number | undefined;
	if (type === "sampling" && raw.timeDeltas?.length) {
		const nonZero = raw.timeDeltas.filter((d) => d > 0);
		if (nonZero.length > 0) {
			// Use median instead of mean to ignore large outlier gaps
			// (BC scheduled profiler profiles have huge idle gaps between samples)
			const sorted = [...nonZero].sort((a, b) => a - b);
			samplingInterval = sorted[Math.floor(sorted.length / 2)];
		}
	}

	return {
		type,
		sourceFormat: "alcpuprofile",
		nodes: raw.nodes,
		nodeMap,
		rootNodes,
		startTime: raw.startTime,
		endTime: raw.endTime,
		totalDuration,
		samples: raw.samples,
		timeDeltas: raw.timeDeltas,
		sampleExecutionTimes: raw.sampleExecutionTimes,
		samplingInterval,
	};
}
