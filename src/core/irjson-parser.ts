import { config } from "../config.js";
import { IRJSON_SCHEMA_VERSION, type IrJsonDocument } from "../types/irjson.js";
import type { ParsedProfile, RawProfileNode } from "../types/profile.js";

/** ir-json ticks are 100 ns; al-perf internal times are µs. */
const TICKS_PER_MICROSECOND = 10;

/**
 * Payload sniffer: an ir-json document has a numeric top-level schemaVersion,
 * a capture object, and an invocations array — and no V8 `nodes` array.
 */
export function isIrJsonDocument(raw: unknown): raw is IrJsonDocument {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return false;
	}
	const doc = raw as Record<string, unknown>;
	return (
		typeof doc.schemaVersion === "number" &&
		Array.isArray(doc.invocations) &&
		typeof doc.capture === "object" &&
		doc.capture !== null &&
		!Array.isArray(doc.nodes)
	);
}

export interface ParseIrJsonOptions {
	/** Override the invocation budget (defaults to config.irJson.maxInvocations). */
	maxInvocations?: number;
}

/**
 * Parse an ir-json document into a ParsedProfile by synthesizing one
 * RawProfileNode per invocation:
 *
 * - node id = invocation index + 1 (1-based, like V8 profile node ids)
 * - hitCount = 1 per node, so aggregateByMethod sums to EXACT invocation counts
 * - children wired from temporalParentIx (the TRUE temporal call tree)
 * - exact self times (selfTicks / 10 µs) returned via exactSelfTimes —
 *   processProfile prefers them over any statistical computation
 * - wire lines/columns are 0-based; the +1 display shift happens HERE and
 *   only here (downstream code always sees V8 display lines)
 * - node span times only when inSweep, using clampedEndTicks ?? endTicks
 *   (raw endTicks is untrustworthy on isIncomplete rows — spec §3.5)
 *
 * Deliberately dropped in this phase: v8AggregationParentIx (not the call
 * tree), per-line hits (no per-line time exists to feed lineHotspots), and
 * per-invocation exceptions (capture-level count is carried in irCapture).
 */
export function parseIrJson(
	doc: IrJsonDocument,
	options?: ParseIrJsonOptions,
): ParsedProfile {
	if (doc.schemaVersion !== IRJSON_SCHEMA_VERSION) {
		throw new Error(
			`Unsupported ir-json schemaVersion ${doc.schemaVersion} (this build expects ${IRJSON_SCHEMA_VERSION})`,
		);
	}
	const maxInvocations =
		options?.maxInvocations ?? config.irJson.maxInvocations;
	if (doc.invocations.length > maxInvocations) {
		throw new Error(
			`ir-json exceeds invocation budget: ${doc.invocations.length} invocations > ${maxInvocations}`,
		);
	}

	const nodes: RawProfileNode[] = [];
	const exactSelfTimes = new Map<number, number>();

	for (let i = 0; i < doc.invocations.length; i++) {
		const inv = doc.invocations[i];
		if (inv.index !== i) {
			throw new Error(
				`ir-json invocation at position ${i} carries index ${inv.index}`,
			);
		}
		if (
			inv.temporalParentIx !== null &&
			(inv.temporalParentIx < 0 || inv.temporalParentIx >= i)
		) {
			throw new Error(
				`ir-json invocation ${i} has invalid temporalParentIx ${inv.temporalParentIx} (must be < index)`,
			);
		}
		const app = inv.appIx !== null ? doc.apps[inv.appIx] : undefined;
		if (inv.appIx !== null && !app) {
			throw new Error(
				`ir-json invocation ${i} has out-of-range appIx ${inv.appIx}`,
			);
		}

		const id = i + 1;
		const node: RawProfileNode = {
			id,
			callFrame: {
				functionName: inv.method ?? "(unknown)",
				scriptId: "",
				url: "",
				lineNumber: inv.calledLine ? inv.calledLine.line + 1 : 0,
				columnNumber: inv.calledLine ? inv.calledLine.column + 1 : 0,
			},
			hitCount: 1,
			children: [],
			applicationDefinition: {
				objectType: inv.objectType ?? "",
				objectName: inv.objectName ?? "",
				objectId: inv.objectId ?? 0,
			},
			declaringApplication: app
				? {
						appId: app.id || undefined,
						appName: app.name,
						appPublisher: app.publisher,
						appVersion: app.version,
					}
				: undefined,
			frameIdentifier: 0,
			isIncompleteMeasurement: inv.isIncomplete,
			isBuiltinCodeUnitCall: inv.isBuiltin,
		};

		if (inv.inSweep && inv.startTicks !== null) {
			node.startTime = inv.startTicks / TICKS_PER_MICROSECOND;
			const effectiveEnd = inv.clampedEndTicks ?? inv.endTicks;
			if (effectiveEnd !== null) {
				node.endTime = effectiveEnd / TICKS_PER_MICROSECOND;
			}
		}

		if (inv.temporalParentIx !== null) {
			// Parent already exists: temporalParentIx < index is validated above.
			nodes[inv.temporalParentIx].children.push(id);
		}

		exactSelfTimes.set(id, inv.selfTicks / TICKS_PER_MICROSECOND);
		nodes.push(node);
	}

	const nodeMap = new Map<number, RawProfileNode>();
	for (const node of nodes) {
		nodeMap.set(node.id, node);
	}
	const rootNodes = nodes.filter(
		(_, i) => doc.invocations[i].temporalParentIx === null,
	);

	const startTime = doc.capture.startTicks / TICKS_PER_MICROSECOND;
	const endTime = doc.capture.endTicks / TICKS_PER_MICROSECOND;

	return {
		type: "instrumentation",
		sourceFormat: "ir-json",
		nodes,
		nodeMap,
		rootNodes,
		startTime,
		endTime,
		totalDuration: endTime - startTime,
		exactSelfTimes,
		irCapture: {
			invocationCount: doc.capture.invocationCount,
			incompleteCount: doc.capture.incompleteCount,
			exceptionCount: doc.capture.exceptionCount,
		},
	};
}
