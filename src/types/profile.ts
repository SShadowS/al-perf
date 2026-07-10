// === Raw JSON shapes (as they appear in .alcpuprofile files) ===

export interface RawCallFrame {
	functionName: string;
	scriptId: string;
	url: string;
	lineNumber: number;
	columnNumber: number;
}

export interface RawDeclaringApplication {
	/**
	 * The declaring app's `id` GUID. Present on every declaringApplication in a
	 * real BC profile (keys: appId/appName/appPublisher/appVersion). Optional
	 * because synthetic/test fixtures may omit it. Used to match the workspace
	 * app.json `id` so the version guard compares the RIGHT app (not the
	 * globally most-frequent third-party/base-app frame). BC profile appIds are
	 * often dash-less hex (e.g. "437dbf0e84ff417a965ded2bb9650972").
	 */
	appId?: string;
	appName: string;
	appPublisher: string;
	appVersion: string;
}

export interface RawApplicationDefinition {
	objectType: string; // "Page", "CodeUnit", "Table", "TableData", etc.
	objectName: string;
	objectId: number;
}

export interface RawPositionTick {
	line: number;
	column: number;
	ticks: number;
	executionTime: number; // microseconds
}

export interface RawProfileNode {
	id: number;
	callFrame: RawCallFrame;
	hitCount: number;
	children: number[];
	declaringApplication?: RawDeclaringApplication;
	applicationDefinition: RawApplicationDefinition;
	frameIdentifier: number;
	// Instrumentation-only fields
	positionTicks?: RawPositionTick[];
	startTime?: number;
	endTime?: number;
	isIncompleteMeasurement?: boolean;
	isBuiltinCodeUnitCall?: boolean;
}

export interface RawProfile {
	nodes: RawProfileNode[];
	startTime: number;
	endTime: number;
	// Sampling-specific
	kind?: number; // 1 = sampling
	// Both formats have these (instrumentation includes them too)
	samples?: number[];
	timeDeltas?: number[];
	// Instrumentation-specific
	sampleExecutionTimes?: number[];
}

// === Processed / normalized types ===

export type ProfileType = "sampling" | "instrumentation";

export type ProfileSourceFormat = "alcpuprofile" | "ir-json";

export interface ParsedProfile {
	type: ProfileType;
	nodes: RawProfileNode[];
	nodeMap: Map<number, RawProfileNode>;
	rootNodes: RawProfileNode[]; // Nodes not referenced as children by any other node
	startTime: number;
	endTime: number;
	totalDuration: number; // endTime - startTime (microseconds)
	samples?: number[];
	timeDeltas?: number[];
	sampleExecutionTimes?: number[];
	samplingInterval?: number; // Derived average interval for sampling profiles (microseconds)
	/** Wire format this profile was parsed from. Absent = "alcpuprofile" (legacy callers). */
	sourceFormat?: ProfileSourceFormat;
	/**
	 * Exact per-node self time in µs, keyed by node id (ir-json only).
	 * When present it overrides the positionTicks / sample-count computation.
	 */
	exactSelfTimes?: Map<number, number>;
	/** ir-json capture-level counters (ir-json only). */
	irCapture?: {
		invocationCount: number;
		incompleteCount: number;
		exceptionCount: number;
	};
}
