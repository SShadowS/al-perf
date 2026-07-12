/**
 * config-file.ts — file-overridable lifecycle telemetry and capture-request
 * thresholds (D2 deep merge, D3 `@clientType` severity key convention).
 *
 * `mergeLifecycleConfig` is the pure merge used everywhere a LifecycleConfig
 * is needed at runtime; `loadLifecycleConfigFile` reads and validates the
 * `telemetry`/`captureRequests` blocks of `.al-perf/lifecycle.config.json`.
 * The `sinks` block belongs to loadSinksConfig (sinks/types.ts) and is
 * intentionally ignored here.
 */

import { existsSync, readFileSync } from "fs";
import type { LifecycleConfig } from "./config.js";

/** Shape of the file's lifecycle-relevant blocks after validation. */
export interface LifecycleConfigFilePatch {
	telemetry?: {
		maxSignalsPerBatch?: number;
		severity?: Record<string, { warningMs: number; criticalMs: number }>;
		/** Multi-tenant split (pull-telemetry --split-by-customer): AAD tenant GUID → al-perf tenant code. */
		tenantMap?: Record<string, string>;
		/** What to do with telemetry from AAD tenants absent from tenantMap: skip (default, loud) or bucket under the --tenant value. */
		unmappedTenantPolicy?: "skip" | "fleet";
	};
	captureRequests?: Partial<LifecycleConfig["captureRequests"]>;
}

/** Deep-merge a validated partial onto the defaults (D2). Pure. */
export function mergeLifecycleConfig(
	base: LifecycleConfig,
	patch: LifecycleConfigFilePatch,
): LifecycleConfig {
	return {
		...base,
		telemetry: {
			maxSignalsPerBatch:
				patch.telemetry?.maxSignalsPerBatch ??
				base.telemetry.maxSignalsPerBatch,
			severity: {
				...base.telemetry.severity,
				...patch.telemetry?.severity,
			},
			tenantMap: {
				...base.telemetry.tenantMap,
				...patch.telemetry?.tenantMap,
			},
			unmappedTenantPolicy:
				patch.telemetry?.unmappedTenantPolicy ??
				base.telemetry.unmappedTenantPolicy,
		},
		captureRequests: {
			...base.captureRequests,
			...patch.captureRequests,
		},
	};
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** D3: plain signal IDs, optionally suffixed with `@ClientType`. */
const SEVERITY_KEY_RE = /^[A-Za-z0-9_]+(@[A-Za-z]+)?$/;
const MIN_SEVERITY_VALUES = ["critical", "warning", "info"] as const;
/**
 * These pass SEVERITY_KEY_RE but a later `severity[key] = ...` bracket
 * assignment on a plain object literal would hit the special `__proto__`
 * setter (or shadow Object.prototype members) instead of storing an own
 * property — the entry silently vanishes rather than failing closed.
 */
const RESERVED_SEVERITY_KEYS = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

/**
 * AAD tenant GUID shape (mirrors web/storage.ts ACTIVITY_ID_RE). Duplicated
 * here rather than imported — src/lifecycle/ must not depend on web/.
 * Reserved keys like `__proto__` never match this shape, so no separate
 * reserved-key set is needed here (unlike RESERVED_SEVERITY_KEYS above).
 */
const TENANT_GUID_RE =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * al-perf tenant code shape (mirrors web/storage.ts TENANT_CODE_RE).
 * Duplicated here rather than imported — src/lifecycle/ must not depend on
 * web/.
 */
const TENANT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

const UNMAPPED_TENANT_POLICY_VALUES = ["skip", "fleet"] as const;

function isPositiveInteger(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isFinitePositiveNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function validateTelemetryBlock(
	path: string,
	telemetry: Record<string, unknown>,
): NonNullable<LifecycleConfigFilePatch["telemetry"]> {
	const result: NonNullable<LifecycleConfigFilePatch["telemetry"]> = {};

	if (telemetry.maxSignalsPerBatch !== undefined) {
		const v = telemetry.maxSignalsPerBatch;
		if (!isPositiveInteger(v)) {
			throw new Error(
				`${path}: telemetry.maxSignalsPerBatch must be a positive integer (got ${JSON.stringify(v)})`,
			);
		}
		result.maxSignalsPerBatch = v;
	}

	if (telemetry.severity !== undefined) {
		const severityInput = telemetry.severity;
		if (
			typeof severityInput !== "object" ||
			severityInput === null ||
			Array.isArray(severityInput)
		) {
			throw new Error(
				`${path}: telemetry.severity must be an object (got ${JSON.stringify(severityInput)})`,
			);
		}
		const severity: Record<string, { warningMs: number; criticalMs: number }> =
			{};
		for (const [key, value] of Object.entries(
			severityInput as Record<string, unknown>,
		)) {
			if (!SEVERITY_KEY_RE.test(key)) {
				throw new Error(
					`${path}: telemetry.severity key "${key}" is invalid (must match ${SEVERITY_KEY_RE})`,
				);
			}
			if (RESERVED_SEVERITY_KEYS.has(key)) {
				throw new Error(
					`${path}: telemetry.severity key "${key}" is reserved and not allowed`,
				);
			}
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw new Error(
					`${path}: telemetry.severity.${key} must be an object (got ${JSON.stringify(value)})`,
				);
			}
			const entry = value as Record<string, unknown>;
			const warningMs = entry.warningMs;
			const criticalMs = entry.criticalMs;
			if (!isFinitePositiveNumber(warningMs)) {
				throw new Error(
					`${path}: telemetry.severity.${key}.warningMs must be a finite positive number (got ${JSON.stringify(warningMs)})`,
				);
			}
			if (!isFinitePositiveNumber(criticalMs)) {
				throw new Error(
					`${path}: telemetry.severity.${key}.criticalMs must be a finite positive number (got ${JSON.stringify(criticalMs)})`,
				);
			}
			if (warningMs > criticalMs) {
				throw new Error(
					`${path}: telemetry.severity.${key}.warningMs must be <= criticalMs (got warningMs=${warningMs}, criticalMs=${criticalMs})`,
				);
			}
			severity[key] = { warningMs, criticalMs };
		}
		result.severity = severity;
	}

	if (telemetry.tenantMap !== undefined) {
		const tenantMapInput = telemetry.tenantMap;
		if (
			typeof tenantMapInput !== "object" ||
			tenantMapInput === null ||
			Array.isArray(tenantMapInput)
		) {
			throw new Error(
				`${path}: telemetry.tenantMap must be an object (got ${JSON.stringify(tenantMapInput)})`,
			);
		}
		const tenantMap: Record<string, string> = {};
		// Lowercased GUID -> the first original-case key seen for it, so a
		// case-variant duplicate (e.g. "ABC..." and "abc...") is caught here
		// rather than silently colliding downstream, where lookups are done
		// against the lowercased GUID and would otherwise last-write-win.
		const seenGuidKeys = new Map<string, string>();
		for (const [key, value] of Object.entries(
			tenantMapInput as Record<string, unknown>,
		)) {
			if (!TENANT_GUID_RE.test(key)) {
				throw new Error(
					`${path}: telemetry.tenantMap key "${key}" is not a valid AAD tenant GUID (must match ${TENANT_GUID_RE})`,
				);
			}
			const lowerKey = key.toLowerCase();
			const priorKey = seenGuidKeys.get(lowerKey);
			if (priorKey !== undefined) {
				throw new Error(
					`${path}: telemetry.tenantMap keys "${priorKey}" and "${key}" are case-variant duplicates of the same AAD tenant GUID`,
				);
			}
			seenGuidKeys.set(lowerKey, key);
			if (typeof value !== "string" || !TENANT_CODE_RE.test(value)) {
				throw new Error(
					`${path}: telemetry.tenantMap["${key}"] value ${JSON.stringify(value)} is not a valid tenant code (must match ${TENANT_CODE_RE})`,
				);
			}
			// Lowercased here — this loader is the sole authoring chokepoint for
			// tenantMap, and nothing downstream normalizes. Without this, "Acme"
			// in the file vs "acme" everywhere else silently splits one
			// customer's history into two case-distinct SQLite tenants.
			tenantMap[key] = value.toLowerCase();
		}
		result.tenantMap = tenantMap;
	}

	if (telemetry.unmappedTenantPolicy !== undefined) {
		const v = telemetry.unmappedTenantPolicy;
		if (!(UNMAPPED_TENANT_POLICY_VALUES as readonly unknown[]).includes(v)) {
			throw new Error(
				`${path}: telemetry.unmappedTenantPolicy must be one of ${UNMAPPED_TENANT_POLICY_VALUES.map((p) => `"${p}"`).join(", ")} (got ${JSON.stringify(v)})`,
			);
		}
		result.unmappedTenantPolicy = v as "skip" | "fleet";
	}

	return result;
}

function validateCaptureRequestsBlock(
	path: string,
	cr: Record<string, unknown>,
): NonNullable<LifecycleConfigFilePatch["captureRequests"]> {
	const result: NonNullable<LifecycleConfigFilePatch["captureRequests"]> = {};

	if (cr.enabled !== undefined) {
		if (typeof cr.enabled !== "boolean") {
			throw new Error(
				`${path}: captureRequests.enabled must be a boolean (got ${JSON.stringify(cr.enabled)})`,
			);
		}
		result.enabled = cr.enabled;
	}

	if (cr.minOccurrences !== undefined) {
		if (!isPositiveInteger(cr.minOccurrences)) {
			throw new Error(
				`${path}: captureRequests.minOccurrences must be a positive integer (got ${JSON.stringify(cr.minOccurrences)})`,
			);
		}
		result.minOccurrences = cr.minOccurrences;
	}

	if (cr.ttlDays !== undefined) {
		if (!isPositiveInteger(cr.ttlDays)) {
			throw new Error(
				`${path}: captureRequests.ttlDays must be a positive integer (got ${JSON.stringify(cr.ttlDays)})`,
			);
		}
		result.ttlDays = cr.ttlDays;
	}

	if (cr.maxPending !== undefined) {
		if (!isPositiveInteger(cr.maxPending)) {
			throw new Error(
				`${path}: captureRequests.maxPending must be a positive integer (got ${JSON.stringify(cr.maxPending)})`,
			);
		}
		result.maxPending = cr.maxPending;
	}

	if (cr.minSeverity !== undefined) {
		if (!(MIN_SEVERITY_VALUES as readonly unknown[]).includes(cr.minSeverity)) {
			throw new Error(
				`${path}: captureRequests.minSeverity must be one of ${MIN_SEVERITY_VALUES.map((v) => `"${v}"`).join(", ")} (got ${JSON.stringify(cr.minSeverity)})`,
			);
		}
		result.minSeverity = cr.minSeverity as "critical" | "warning" | "info";
	}

	return result;
}

/**
 * Read + validate the lifecycle blocks of .al-perf/lifecycle.config.json.
 * Missing file → null (defaults apply). Malformed JSON or mistyped field →
 * throw naming the path and field (fail-closed, loadSinksConfig posture).
 * The `sinks` block is ignored here (loadSinksConfig owns it).
 */
export function loadLifecycleConfigFile(
	path: string,
): LifecycleConfigFilePatch | null {
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		throw new Error(`${path} is not valid JSON: ${err}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(
			`${path}: root must be an object (got ${JSON.stringify(parsed)})`,
		);
	}
	const cfg = parsed as Record<string, unknown>;
	const result: LifecycleConfigFilePatch = {};

	if (cfg.telemetry !== undefined) {
		const telemetry = cfg.telemetry;
		if (
			typeof telemetry !== "object" ||
			telemetry === null ||
			Array.isArray(telemetry)
		) {
			throw new Error(
				`${path}: telemetry must be an object (got ${JSON.stringify(telemetry)})`,
			);
		}
		result.telemetry = validateTelemetryBlock(
			path,
			telemetry as Record<string, unknown>,
		);
	}

	if (cfg.captureRequests !== undefined) {
		const captureRequests = cfg.captureRequests;
		if (
			typeof captureRequests !== "object" ||
			captureRequests === null ||
			Array.isArray(captureRequests)
		) {
			throw new Error(
				`${path}: captureRequests must be an object (got ${JSON.stringify(captureRequests)})`,
			);
		}
		result.captureRequests = validateCaptureRequestsBlock(
			path,
			captureRequests as Record<string, unknown>,
		);
	}

	// `sinks` is intentionally not read here — loadSinksConfig owns it.
	return result;
}
