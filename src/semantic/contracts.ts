/**
 * contracts.ts — Local TS mirror of the al-sem CLI JSON envelopes.
 *
 * al-perf does NOT import al-sem as a library. These types are derived from
 * inspecting the real CLI output (`alsem fingerprint --inventory-only` and
 * `alsem analyze`) and are pinned to the schema versions below.
 *
 * When the engine bumps its schemaVersion, update EXPECTED_*_SCHEMA_VERSION
 * here and re-baseline the goldens under test/fixtures/fusion/.
 */

// ---------------------------------------------------------------------------
// Schema version constants (the contract pins)
// ---------------------------------------------------------------------------

/** The schemaVersion we expect from `alsem fingerprint --inventory-only`. */
export const EXPECTED_INVENTORY_SCHEMA_VERSION = "1.1.0";

/** The schemaVersion we expect from `alsem analyze`. */
export const EXPECTED_ANALYZE_SCHEMA_VERSION = "1.1.0";

// ---------------------------------------------------------------------------
// Shared envelope types
// ---------------------------------------------------------------------------

/** An app identity as emitted by al-sem. */
export interface AppIdentity {
	appGuid: string;
	name: string;
	publisher: string;
	version: string;
}

// ---------------------------------------------------------------------------
// Inventory envelope  (kind: "routine-inventory")
// ---------------------------------------------------------------------------

/**
 * A single routine entry in the inventory projection.
 * Emitted by `alsem fingerprint <ws> --inventory-only --format json`.
 *
 * Schema 1.1.0: `enclosingMember` + `originatingObject` are present only for
 * member-trigger routines (field/control/action OnValidate etc.). Absent for
 * procedures and object-level triggers. An old engine (1.0.0) omits them →
 * both fields are `undefined` and the consumer degrades gracefully.
 */
export interface RoutineIdentity {
	stableRoutineId: string;
	objectType: string;
	objectNumber: number;
	routineName: string;
	/** Present only for member-trigger routines (schema 1.1.0+). */
	enclosingMember?: string;
	/** Present only for member-trigger routines (schema 1.1.0+). */
	originatingObject?: string;
}

/** One coverage entry in the inventory payload. */
export interface CoverageEntry {
	directStatus: string;
	inheritedStatus: string;
	reasons: string[];
	subject: string;
	unknownTargets: string[];
}

/** One root-classification entry. */
export interface RootClassification {
	confidence: string;
	externallyReachable: boolean;
	kinds: string[];
	routineId: string;
	source: string;
	sourceAnchor: {
		enclosingRoutineId: string;
		range: {
			endColumn: number;
			endLine: number;
			startColumn: number;
			startLine: number;
		};
		sourceUnitId: string;
		syntaxKind: string;
	};
}

/** The identities block in the inventory payload. */
export interface IdentitiesBlock {
	displayNames: string[];
	stableIds: string[];
}

/** Payload of the inventory document. */
export interface InventoryPayload {
	apps: AppIdentity[];
	coverage: CoverageEntry[];
	identities: IdentitiesBlock;
	rootClassifications: RootClassification[];
	routineInventory: RoutineIdentity[];
}

/** A diagnostic entry as emitted in document envelopes. */
export interface DiagnosticContract {
	/** Diagnostic code / category string. */
	code?: string;
	message: string;
	severity?: string;
}

/**
 * The full `routine-inventory` document envelope.
 * Produced by `alsem fingerprint <ws> --inventory-only --format json --deterministic`.
 */
export interface InventoryDoc {
	kind: "routine-inventory";
	schemaVersion: string;
	alsemVersion: string;
	deterministic: boolean;
	generatedAt: string;
	diagnostics: DiagnosticContract[];
	payload: InventoryPayload;
}

// ---------------------------------------------------------------------------
// Analyze-report envelope  (kind: "analyze-report")
// ---------------------------------------------------------------------------

/** Source location within a finding. */
export interface FindingLocation {
	file: string;
	line: number;
	column: number;
	objectId?: string;
	objectName?: string;
	routineId?: string;
	routineName?: string;
	/** Present when the finding is inside a member-trigger (schema 1.1.0+, --with-evidence). */
	enclosingMember?: string;
	/** Present when the finding is inside a member-trigger (schema 1.1.0+, --with-evidence). */
	originatingObject?: string;
}

/**
 * One step in an evidence path as emitted by `alsem analyze --with-evidence`.
 * The engine emits `sourceAnchor: { sourceUnitId, range: { startLine, … },
 * enclosingRoutineId, syntaxKind }`; al-perf flattens it to top-level
 * `file` (= `sourceAnchor.sourceUnitId`) + `line` (= `sourceAnchor.range.startLine`).
 * `routineId` is in `:`-form (StableRoutineId). `callsiteId` is dropped on mapping.
 */
export interface EvidenceStep {
	routineId: string;
	file: string;
	line: number;
	note: string;
	operationId?: string;
	loopId?: string;
}

/** Fix hint attached to a finding. */
export interface FixHint {
	description: string;
	safety: string;
}

/**
 * A single finding as emitted by `alsem analyze --format json`.
 * Mirrored from al-sem `src/projection/finding-summary.ts` / the real golden.
 *
 * NOTE: `objectId` in `primaryLocation` uses `/` as delimiter:
 * `"<appGuid>/<objectType>/<objectNumber>"` (the internal ObjectId form,
 * NOT the snapshot `:`-form). Parse on `/` into 3 segments.
 */
export interface FindingSummary {
	id: string;
	fingerprint: string;
	detector: string;
	title: string;
	rootCause: string;
	severity: string;
	confidence: {
		level: string;
		cappedBy?: string[];
	};
	primaryLocation: FindingLocation;
	terminalLocation?: FindingLocation;
	affectedObjects: string[];
	affectedTables: string[];
	fixHint?: FixHint;
	pathCount?: number;
	/**
	 * The call chain from the finding's anchor to the issue (schema 1.1.0+,
	 * only when `analyze --with-evidence` is passed). Each step carries the
	 * engine's `sourceAnchor` mapped to `{file, line}`. Absent for an old
	 * engine or a detector that emits no path.
	 */
	evidencePath?: EvidenceStep[];
}

/** Per-detector stats in the analyze summary. */
export interface DetectorStat {
	candidatesConsidered: number;
	detector: string;
	findingsEmitted: number;
	skipped: Record<string, number>;
}

/** Summary block in the analyze-report payload. */
export interface AnalyzeSummary {
	byDetector: Record<string, number>;
	bySeverity: Record<string, number>;
	detectorStats: DetectorStat[];
	opaqueApps: string[];
	routinesAnalyzed: number;
	sourceUnitsParsed: number;
	totalFindings: number;
}

/** Payload of the analyze-report document. */
export interface AnalyzePayload {
	findings: FindingSummary[];
	summary: AnalyzeSummary;
}

/**
 * The full `analyze-report` document envelope.
 * Produced by `alsem analyze <ws> --format json --deterministic`.
 */
export interface AnalyzeReport {
	kind: "analyze-report";
	schemaVersion: string;
	alsemVersion: string;
	deterministic: boolean;
	generatedAt: string;
	diagnostics: DiagnosticContract[];
	payload: AnalyzePayload;
}
