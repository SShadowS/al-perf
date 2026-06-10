/**
 * identity.ts — Identity normalization helpers for the al-sem correlation layer.
 *
 * These functions form the bridge between al-perf's runtime method identities
 * (from `.alcpuprofile` data, e.g. `CodeUnit`, `XMLPort`) and al-sem's static
 * analysis identities (AL-keyword case: `Codeunit`, `XMLport`, etc.).
 *
 * Contract:
 *  - `parseObjectId`        — split a `/`-delimited internal ObjectId → components.
 *  - `canonicalObjectType`  — normalise any spelling → al-sem canonical AL-keyword case.
 *  - `normalizeTriggerName` — strip `"<member> - "` prefix from field/page triggers.
 *  - `isAlRoutineFrame`     — filter out SQL-statement frames and builtins.
 */

import type { MethodBreakdown } from "../types/aggregated.js";

// ---------------------------------------------------------------------------
// parseObjectId
// ---------------------------------------------------------------------------

export interface ParsedObjectId {
	appGuid: string;
	objectType: string;
	objectNumber: number;
}

/**
 * Parse an al-sem internal ObjectId of the form
 * `<appGuid>/<objectType>/<objectNumber>`.
 *
 * The appGuid is a GUID (hyphens only, NO slashes). The string is split on `/`
 * into exactly 3 segments. Returns `null` on any malformation: wrong segment
 * count, non-integer objectNumber, or empty segments.
 *
 * @example
 * parseObjectId("a1b2c3d4-e5f6-7890-abcd-ef1234567890/Codeunit/50100")
 * // → { appGuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
 * //     objectType: "Codeunit", objectNumber: 50100 }
 *
 * parseObjectId("bad:colon:form")    // → null
 * parseObjectId("a/b/c/d")           // → null  (4 segments)
 * parseObjectId("a/Codeunit/notnum") // → null
 */
export function parseObjectId(id: string): ParsedObjectId | null {
	const parts = id.split("/");
	if (parts.length !== 3) return null;

	const [appGuid, objectType, objectNumberStr] = parts;
	if (!appGuid || !objectType || !objectNumberStr) return null;

	const objectNumber = Number.parseInt(objectNumberStr, 10);
	if (
		!Number.isFinite(objectNumber) ||
		String(objectNumber) !== objectNumberStr
	)
		return null;

	return { appGuid, objectType, objectNumber };
}

// ---------------------------------------------------------------------------
// canonicalObjectType
// ---------------------------------------------------------------------------

/**
 * Bidirectional normalisation table: (lowercase input) → canonical AL-keyword case.
 *
 * Sources:
 *  - al-sem emits `Codeunit`/`XMLport`/`Table`/`Page`/`Report`/`Query`/`Enum`/
 *    `Interface`/`TableExtension`/`PageExtension`/`EnumExtension`/`ReportExtension`/
 *    `PermissionSet`/`ControlAddIn` (from the indexer OBJECT_TYPE_MAP).
 *  - al-perf runtime profiles emit `CodeUnit` (numeric 5) and `XMLPort` (numeric 6)
 *    from `src/core/object-types.ts`.
 *  - `TableData` is an alias for numeric type 1 (Table) seen in some runtime frames.
 */
const CANONICAL_OBJECT_TYPE_TABLE: [string, string][] = [
	// ── Core types ──────────────────────────────────────────────────────────
	["codeunit", "Codeunit"],
	["table", "Table"],
	["page", "Page"],
	["report", "Report"],
	["xmlport", "XMLport"],
	["query", "Query"],
	["enum", "Enum"],
	["interface", "Interface"],
	// ── Extension kinds ──────────────────────────────────────────────────────
	["tableextension", "TableExtension"],
	["pageextension", "PageExtension"],
	["enumextension", "EnumExtension"],
	["reportextension", "ReportExtension"],
	// ── Other standard types ─────────────────────────────────────────────────
	["permissionset", "PermissionSet"],
	["controladdin", "ControlAddIn"],
	// ── Runtime aliases (al-perf's normalizeObjectType output) ──────────────
	// Numeric 5 → "CodeUnit"  (al-perf runtime) → normalise to "Codeunit"
	// (already handled by lowercase "codeunit" above; the runtime string is
	//  "CodeUnit" which lowercases to "codeunit")
	// Numeric 6 → "XMLPort"   (al-perf runtime) → normalise to "XMLport"
	// (already handled by lowercase "xmlport" above; the runtime string is
	//  "XMLPort" which lowercases to "xmlport")
	// ── Special alias ────────────────────────────────────────────────────────
	// "TableData" — seen as a runtime alias for the numeric Table type (1)
	["tabledata", "Table"],
];

const _CANONICAL_MAP: Map<string, string> = new Map(
	CANONICAL_OBJECT_TYPE_TABLE.map(([k, v]) => [k, v]),
);

/**
 * Normalise an AL object-type string (from any source, any casing) to the
 * canonical AL-keyword case that al-sem emits.
 *
 * Input is case-insensitive. Unknown types are returned as-is (no silent loss).
 *
 * @example
 * canonicalObjectType("CodeUnit")        // → "Codeunit"
 * canonicalObjectType("XMLPort")         // → "XMLport"
 * canonicalObjectType("TableData")       // → "Table"
 * canonicalObjectType("Codeunit")        // → "Codeunit"  (already canonical)
 * canonicalObjectType("REPORT")          // → "Report"
 * canonicalObjectType("PageExtension")   // → "PageExtension"
 */
export function canonicalObjectType(s: string): string {
	return _CANONICAL_MAP.get(s.toLowerCase()) ?? s;
}

// ---------------------------------------------------------------------------
// normalizeTriggerName
// ---------------------------------------------------------------------------

/**
 * The set of recognised AL trigger keyword names (lowercased) that may appear
 * as the suffix of a compound field/control trigger function name in a profile.
 *
 * Derived from the AL trigger surface (table field, page control, page, report,
 * codeunit, and request-page triggers). al-sem stores the BARE trigger name as
 * its `routineName`; profiles emit `"<member> - <Trigger>"` for field/control
 * triggers. Only when the suffix after the final ` - ` is one of these do we
 * strip — otherwise a real quoted procedure named e.g. `"Get - Value"` would be
 * wrongly truncated to `"Value"` (→ a spurious blind-spot).
 */
const AL_TRIGGER_KEYWORDS: Set<string> = new Set([
	// Table / table-extension triggers
	"oninsert",
	"onmodify",
	"ondelete",
	"onrename",
	// Field triggers
	"onvalidate",
	"onlookup",
	"onaftervalidate",
	"onbeforevalidate",
	// Page triggers
	"onopenpage",
	"onclosepage",
	"onqueryclosepage",
	"onaftergetrecord",
	"onaftergetcurrrecord",
	"onnewrecord",
	"oninsertrecord",
	"onmodifyrecord",
	"ondeleterecord",
	"onfindrecord",
	"onnextrecord",
	// Page control / action triggers
	"onaction",
	"onassistedit",
	"ondrilldown",
	"oncontroladdinready",
	// Codeunit triggers
	"onrun",
	// Report triggers
	"oninitreport",
	"onprereport",
	"onpostreport",
	"onpredataitem",
	"onpostdataitem",
]);

/**
 * Strip the `"<member> - "` prefix from a field/page trigger function name so
 * it matches al-sem's bare `routineName` — but ONLY when the suffix is a
 * recognised AL trigger keyword.
 *
 * In AL CPU profiles, field and page control triggers are reported as compound
 * names (the field/control name followed by the trigger keyword):
 *   `"Sell-to Customer No. - OnValidate"` → `"OnValidate"`
 *   `"No. - OnInsert"`                    → `"OnInsert"`
 *
 * Plain procedure/trigger names without the separator are returned unchanged:
 *   `"OnRun"`          → `"OnRun"`
 *   `"ProcessRecords"` → `"ProcessRecords"`
 *
 * A quoted procedure name that merely CONTAINS ` - ` but whose suffix is NOT a
 * trigger keyword is left untouched (no over-strip):
 *   `"Get - Value"`    → `"Get - Value"`   (Value is not a trigger keyword)
 *
 * When the separator ` - ` appears multiple times, only the LAST occurrence is
 * considered, so the trigger keyword (the part after the final ` - `) is the
 * candidate suffix.
 */
export function normalizeTriggerName(functionName: string): string {
	const sep = " - ";
	const lastIdx = functionName.lastIndexOf(sep);
	if (lastIdx === -1) return functionName;
	const suffix = functionName.slice(lastIdx + sep.length);
	// Only strip when the suffix is a genuine trigger keyword.
	if (!AL_TRIGGER_KEYWORDS.has(suffix.toLowerCase())) return functionName;
	return suffix;
}

// ---------------------------------------------------------------------------
// extractMemberTrigger
// ---------------------------------------------------------------------------

/**
 * Split a compound profile function name `"<member> - <trigger>"` into its
 * constituent member and trigger parts — but ONLY when the suffix after the
 * LAST `" - "` is a recognised AL trigger keyword.
 *
 * The `&` accelerator character is stripped from the member name so that action
 * captions like `"Re&lease - OnAction"` match an inventory `enclosingMember` of
 * `"Release"` (RE-4 contract).
 *
 * Returns `null` when:
 *  - the separator `" - "` does not appear in the name, OR
 *  - the suffix after the last `" - "` is not an AL trigger keyword.
 *
 * @example
 * extractMemberTrigger("Sell-to Customer No. - OnValidate")
 * // → { member: "Sell-to Customer No.", trigger: "OnValidate" }
 *
 * extractMemberTrigger("Re&lease - OnAction")
 * // → { member: "Release", trigger: "OnAction" }
 *
 * extractMemberTrigger("OnRun")
 * // → null  (no separator)
 *
 * extractMemberTrigger("Get - Value")
 * // → null  (Value is not a trigger keyword)
 */
export function extractMemberTrigger(
	functionName: string,
): { member: string; trigger: string } | null {
	const sep = " - ";
	const lastIdx = functionName.lastIndexOf(sep);
	if (lastIdx === -1) return null;
	const trigger = functionName.slice(lastIdx + sep.length);
	if (!AL_TRIGGER_KEYWORDS.has(trigger.toLowerCase())) return null;
	// Strip the '&' accelerator character from the member portion (RE-4).
	const member = functionName.slice(0, lastIdx).replace(/&/g, "").trim();
	// An empty member (e.g. "& - OnAction" → "") can't match a real routine.
	if (member === "") return null;
	return { member, trigger };
}

// ---------------------------------------------------------------------------
// normalizeAppGuid
// ---------------------------------------------------------------------------

/**
 * Normalize an app GUID for comparison: strip dashes + lowercase.
 *
 * BC profile `declaringApplication.appId` values are often dash-less hex
 * (e.g. `"437dbf0e84ff417a965ded2bb9650972"`) while al-sem's
 * `originatingObject` prefix and `app.json` ids carry dashes
 * (e.g. `"437dbf0e-84ff-417a-965d-ed2bb9650972"`). Stripping dashes + lower-
 * casing makes the two forms comparable.
 *
 * Returns `""` for `undefined` or empty strings so a missing id never
 * spuriously matches another.
 *
 * Shared between `analyzer.ts` (workspace-app version guard) and
 * `correlate.ts` (app-scope gate).
 */
export function normalizeAppGuid(id: string | undefined): string {
	if (!id) return "";
	return id.replace(/-/g, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// isAlRoutineFrame
// ---------------------------------------------------------------------------

/**
 * Lowercase prefixes that identify SQL-statement `functionName` values in profiles.
 * These are literal SQL query strings, not AL routine names.
 */
const SQL_PREFIXES: string[] = [
	"select ",
	"insert ",
	"update ",
	"delete ",
	"if exists",
	"if not exists",
	"exec ",
	"execute ",
	"merge ",
	"truncate ",
	"create ",
	"drop ",
	"alter ",
	"with ",
];

/**
 * Return `true` when this `MethodBreakdown` represents an AL routine that
 * al-sem could plausibly have analysed — i.e. it should enter the correlation
 * universe and, if absent, count as a blind-spot.
 *
 * EXCLUDED frames:
 *  - `isBuiltin === true`        — BC system/builtin codeunits al-sem cannot see.
 *  - SQL-statement function names — literal SQL queries embedded in profiles as
 *    `functionName` (start with SELECT/INSERT/UPDATE/DELETE/IF EXISTS/EXEC/…).
 *
 * @example
 * isAlRoutineFrame({ functionName: "ProcessRecords", isBuiltin: false, … }) // true
 * isAlRoutineFrame({ functionName: "OnRun",          isBuiltin: true,  … }) // false
 * isAlRoutineFrame({ functionName: "SELECT TOP 1 …", isBuiltin: false, … }) // false
 */
export function isAlRoutineFrame(m: MethodBreakdown): boolean {
	if (m.isBuiltin === true) return false;

	const lower = m.functionName.toLowerCase().trimStart();
	for (const prefix of SQL_PREFIXES) {
		if (lower.startsWith(prefix)) return false;
	}

	return true;
}
