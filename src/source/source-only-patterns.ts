import { sortPatterns } from "../core/patterns.js";
import type { DetectedPattern, PatternSeverity } from "../types/patterns.js";
import type {
	ProcedureInfo,
	ResolvedTable,
	SourceIndex,
	TriggerInfo,
} from "../types/source-index.js";
import {
	downgradePageImplicitLoop,
	loopEvidencePhrase,
	loopLocationPhrase,
} from "./implicit-loop.js";
import { isKnownNonRecordOp } from "./source-patterns.js";

/**
 * Format a member label for use in involvedMethods arrays.
 */
function memberLabel(member: ProcedureInfo | TriggerInfo): string {
	return `${member.name} (${member.objectType} ${member.objectId})`;
}

/**
 * Detect nested loops (a loop inside another loop).
 * Uses lineStart/lineEnd ranges to determine containment.
 * Severity: warning.
 */
export function detectNestedLoops(index: SourceIndex): DetectedPattern[] {
	const patterns: DetectedPattern[] = [];

	for (const obj of index.objects.values()) {
		const allMembers = [...obj.procedures, ...obj.triggers];
		for (const member of allMembers) {
			const loops = member.features.loops;
			if (loops.length < 2) continue;

			const reported = new Set<number>();
			for (const outer of loops) {
				for (const inner of loops) {
					if (inner === outer) continue;
					if (reported.has(inner.lineStart)) continue;
					if (
						inner.lineStart > outer.lineStart &&
						inner.lineEnd <= outer.lineEnd
					) {
						// Nesting only multiplies DATABASE cost when the inner body
						// actually reaches the database. A `for i := 1 to
						// KRef.FieldCount` walking key fields through FieldRef is
						// bounded by the key width and touches nothing — flagging it
						// tells the reader to restructure a loop that costs nothing.
						//
						// Recall trade: an inner loop whose I/O happens inside a
						// procedure it calls is invisible here and is no longer
						// reported. Not observed on the measured corpus — every inner
						// loop there with no record op of its own also did no I/O by
						// proxy — but that is the shape this misses.
						const innerHasRecordOp = member.features.recordOps.some(
							(op) => op.line >= inner.lineStart && op.line <= inner.lineEnd,
						);
						if (!innerHasRecordOp) continue;
						reported.add(inner.lineStart);
						patterns.push({
							id: "nested-loops",
							severity: "warning",
							title: `Nested ${inner.type} loop inside ${outer.type} loop in ${member.name}`,
							description: `A ${inner.type} loop (line ${inner.lineStart}) is nested inside a ${outer.type} loop (line ${outer.lineStart}) in ${member.file}. Nested loops multiply iteration counts and can cause severe performance degradation.`,
							impact: 0,
							involvedMethods: [memberLabel(member)],
							evidence: `${inner.type} loop at line ${inner.lineStart}-${inner.lineEnd} inside ${outer.type} loop at line ${outer.lineStart}-${outer.lineEnd}`,
							suggestion:
								"Consider restructuring to avoid nested loops. Pre-load inner data before the outer loop, or use bulk operations.",
						});
					}
				}
			}
		}
	}

	return patterns;
}

/**
 * Detect FindSet/FindFirst/FindLast without any preceding SetRange/SetFilter
 * on the same record variable within the same procedure.
 * Severity: warning.
 */
export function detectUnfilteredFindSet(index: SourceIndex): DetectedPattern[] {
	const FIND_OPS = new Set(["FindSet", "FindFirst", "FindLast"]);
	// SetView belongs here and SetCurrentKey does not: SetView applies a filter
	// group (it is how a caller-supplied filter string reaches the record),
	// while SetCurrentKey only picks the sort order and restricts nothing.
	// CopyFilters (plural) copies every filter onto the RECEIVER, so it belongs
	// here too; CopyFilter (singular) filters the record owning its second
	// argument instead, and is resolved separately below.
	const FILTER_OPS = new Set([
		"SetRange",
		"SetFilter",
		"SetView",
		"CopyFilters",
	]);
	const patterns: DetectedPattern[] = [];

	for (const obj of index.objects.values()) {
		const allMembers = [...obj.procedures, ...obj.triggers];
		for (const member of allMembers) {
			const ops = member.features.recordOps;
			const findOps = ops.filter((op) => FIND_OPS.has(op.type));

			// Collect all record variables that end up carrying a filter
			const filteredVars = new Set<string>();
			for (const op of ops) {
				if (FILTER_OPS.has(op.type) && op.recordVariable) {
					filteredVars.add(op.recordVariable.toLowerCase());
				} else if (op.type === "CopyFilter") {
					// `A.CopyFilter(fieldOfA, B.fieldOfB)` filters B: the target is
					// the qualifier of the second argument, not the receiver.
					const target = op.allFieldArguments?.[1]?.split(".")[0];
					if (target) filteredVars.add(target.toLowerCase());
				}
			}

			// Collect temporary variable names
			const tempVars = new Set<string>(
				member.features.variables
					.filter((v) => v.isTemporary)
					.map((v) => v.name.toLowerCase()),
			);

			for (const op of findOps) {
				const varLower = op.recordVariable?.toLowerCase() ?? "";
				// FIND_OPS matches method NAMES, and RecordRef has FindSet/
				// FindFirst/FindLast too — its filters live on FieldRef, so
				// "add SetRange" is the wrong API. Fails open on an unresolved
				// receiver, so implicit Rec and object-level globals still report.
				if (isKnownNonRecordOp(op, member.features.variables)) continue;
				if (
					varLower &&
					!filteredVars.has(varLower) &&
					!tempVars.has(varLower)
				) {
					// Filters travel WITH a record variable in AL — by value as
					// well as by reference — so a record PARAMETER arrives
					// carrying whatever the caller filtered, and no member-local
					// analysis can see it. 978 of 5,432 candidates on a
					// 15,436-file corpus are on a parameter. Still reported (the
					// caller may equally have filtered nothing) but not as a
					// stated full table scan, which is a claim this detector
					// cannot support there.
					const declared = member.features.variables.find(
						(v) => v.name.toLowerCase() === varLower,
					);
					// The same blindness, one step further out: an object's
					// IMPLICIT record has no declaration anywhere, and arrives
					// filtered by SourceTableView / DataItemTableView, by whatever
					// the caller passed through SetTableView, and — on a Page — by
					// the user's filter pane. 253 candidates on the corpus are an
					// implicit Rec, 173 of them on Pages.
					const implicitRec =
						!declared &&
						varLower === "rec" &&
						IMPLICIT_REC_OBJECT_TYPES.has(obj.objectType);
					const fromCaller = declared?.isParameter === true || implicitRec;
					const whyUnknown = implicitRec
						? `${op.recordVariable} is this ${obj.objectType}'s implicit record: it arrives filtered by SourceTableView, by whatever the caller set through SetTableView, and by the user's filter pane — none of which is visible here.`
						: `${op.recordVariable} is a parameter, and filters travel with a record in AL, so the caller may already have filtered it — or may not have.`;
					patterns.push({
						id: "unfiltered-findset",
						severity: fromCaller ? "info" : "warning",
						title: `${op.type} without filters on ${op.recordVariable} in ${member.name}`,
						description: fromCaller
							? `${op.type}() on ${op.recordVariable} at line ${op.line} in ${member.file} has no preceding SetRange() or SetFilter() in this member. ${whyUnknown}`
							: `${op.type}() on ${op.recordVariable} at line ${op.line} in ${member.file} has no preceding SetRange() or SetFilter(). This queries all records in the table, which can be extremely slow on large tables.`,
						impact: 0,
						involvedMethods: [memberLabel(member)],
						evidence: `${op.type}() at line ${op.line} on ${op.recordVariable} with no SetRange/SetFilter${fromCaller ? ` in this member (${implicitRec ? "implicit record — filtered outside the member" : "parameter — caller may have filtered it"})` : ""}`,
						suggestion: implicitRec
							? `Confirm the ${obj.objectType}'s SourceTableView, and every caller that opens it, leave ${op.recordVariable} filtered. Nothing in this member constrains the read.`
							: fromCaller
								? `Check every caller of ${member.name}: if any passes ${op.recordVariable} unfiltered, this reads the whole table. Filtering inside the member instead makes the guarantee local.`
								: "Add SetRange() or SetFilter() before the record retrieval to limit the result set. Querying entire tables causes full table scans.",
					});
				}
			}
		}
	}

	return patterns;
}

/**
 * Detect event subscriber procedures that have complex features (loops, many record ops).
 * Event subscribers are implicit call points that are easy to overlook.
 * Severity: info (warning if they contain record ops in loops).
 */
export function detectEventSubscriberIssues(
	index: SourceIndex,
): DetectedPattern[] {
	const patterns: DetectedPattern[] = [];

	for (const obj of index.objects.values()) {
		for (const proc of obj.procedures) {
			if (!proc.isEventSubscriber) continue;

			const hasLoops = proc.features.loops.length > 0;
			const hasRecordOpsInLoops = proc.features.recordOpsInLoops.length > 0;

			if (hasRecordOpsInLoops) {
				patterns.push({
					id: "event-subscriber-with-loop-ops",
					severity: "warning",
					title: `Event subscriber ${proc.name} has record operations inside loops`,
					description: `Event subscriber ${proc.name} in ${proc.file} (line ${proc.lineStart}) contains ${proc.features.recordOpsInLoops.length} record operation(s) inside loops. Event subscribers are called implicitly and their performance impact is easy to overlook.`,
					impact: 0,
					involvedMethods: [memberLabel(proc)],
					evidence: `${proc.features.recordOpsInLoops.length} record op(s) in loops within event subscriber`,
					suggestion:
						"Review this event subscriber for performance impact. Consider batching operations or reducing work done inside loops.",
				});
			} else if (hasLoops) {
				patterns.push({
					id: "event-subscriber-with-loops",
					severity: "info",
					title: `Event subscriber ${proc.name} contains loops`,
					description: `Event subscriber ${proc.name} in ${proc.file} (line ${proc.lineStart}) contains ${proc.features.loops.length} loop(s). Event subscribers are called implicitly for every event invocation.`,
					impact: 0,
					involvedMethods: [memberLabel(proc)],
					evidence: `${proc.features.loops.length} loop(s) in event subscriber`,
					suggestion:
						"Ensure loop iterations are bounded and consider whether this subscriber needs to run for every event invocation.",
				});
			}
		}
	}

	return patterns;
}

/**
 * Detect Commit(), Error(), TestField() calls inside loops.
 * These are severe anti-patterns: Commit flushes the transaction per iteration,
 * Error can abort mid-loop, TestField is expensive per-row.
 * Severity: critical (warning for a Page's implicit per-row loop — Task 9 Part B).
 */
export function detectDangerousCallsInLoop(
	index: SourceIndex,
): DetectedPattern[] {
	const patterns: DetectedPattern[] = [];

	for (const obj of index.objects.values()) {
		const members = [...obj.procedures, ...obj.triggers];
		for (const member of members) {
			for (const call of member.features.dangerousCallsInLoops) {
				if (!call.insideLoop) continue;
				const severity = downgradePageImplicitLoop("critical", call);
				patterns.push({
					id: "dangerous-call-in-loop",
					severity,
					title: `${call.type}() inside loop in ${member.name}`,
					description: `${call.type}() ${loopLocationPhrase(call, call.line, member.file)}. Each iteration triggers a separate ${call.type === "Commit" ? "transaction flush" : "error evaluation"} in ${obj.objectType} ${obj.objectName} (${obj.objectId}).`,
					impact: 0,
					involvedMethods: [
						`${member.name} (${obj.objectType} ${obj.objectId})`,
					],
					evidence: `${call.type} at line ${call.line}, column ${call.column} — ${loopEvidencePhrase(call)}`,
					suggestion:
						call.type === "Commit"
							? "Move Commit() outside the loop. Process all records first, then commit once."
							: `Consider collecting validation results and reporting ${call.type}() once after the loop.`,
				});
			}
		}
	}

	return patterns;
}

/**
 * Detect HttpClient.{Send,Get,Post,Put,Patch,Delete} calls (recognized by the
 * receiver variable's declared type) and bare Sleep(...) calls inside loops.
 *
 * A separate pattern id from `dangerous-call-in-loop`, not a widened
 * `DANGEROUS_CALLS` set: Commit/Error/TestField in a loop are *transactional*
 * problems (a Commit in a loop breaks one write transaction into N); an
 * external call in a loop is a *latency* problem (N network round-trips, or N
 * blocking delays) fixed by batching or hoisting — a completely different
 * suggestion. `Codeunit.Run` in a loop is a transaction-boundary problem and
 * is deliberately out of scope here (needs its own thinking, per the brief).
 * Severity: critical (warning for a Page's implicit per-row loop).
 *
 * KNOWN LIMITATION: `HttpClient` calls are recognized by the receiver
 * variable's declared type, resolved from `buildVariableTypeMap`/
 * `extractVariables` in indexer.ts -- which only sees a member's OWN
 * `var_section`, not an object-level global declared above the procedures.
 * An `HttpClient` declared as an object-level global and reused across
 * procedures (normal BC code) is therefore invisible to this detector: the
 * type gate fails closed rather than degrading gracefully. Deliberately
 * deferred, pinned by a negative test (see indexer.ts's `buildVariableTypeMap`
 * doc comment and CLAUDE.md).
 */
/**
 * Whether the loop enclosing `line` terminates on the DATA running out rather
 * than on a condition the body is waiting to change.
 *
 * `for`/`foreach` are bounded by a range or collection, and a `repeat` that
 * ends on `X.Next() = 0` is walking a record set — a delay inside any of them
 * really does multiply by the row count. A `while <predicate>` (or a `repeat`
 * ending on a predicate: `until Success or (RetryCount >= MaxRetries)`) is a
 * WAIT loop: it spins until something changes, and the delay is the mechanism
 * rather than a per-row cost. Telling that author to hoist the Sleep out
 * deletes their backoff or their throttle.
 *
 * An implicit loop (a per-row trigger, no syntactic loop at all) counts as
 * data-driven: the platform runs it once per row by contract.
 */
function isDataDrivenLoopAt(
	member: ProcedureInfo | TriggerInfo,
	line: number,
): boolean {
	let innermost:
		| { lineStart: number; lineEnd: number; type: string }
		| undefined;
	for (const loop of member.features.loops) {
		if (line < loop.lineStart || line > loop.lineEnd) continue;
		if (
			innermost === undefined ||
			loop.lineEnd - loop.lineStart < innermost.lineEnd - innermost.lineStart
		) {
			innermost = loop;
		}
	}
	if (innermost === undefined) return true; // implicit (per-row trigger) loop
	if (innermost.type === "for" || innermost.type === "foreach") return true;
	if (innermost.type === "while") return false;
	// repeat: data-driven only when it is walking a record set.
	return member.features.recordOps.some(
		(op) =>
			op.type === "Next" &&
			op.line >= innermost.lineStart &&
			op.line <= innermost.lineEnd,
	);
}

export function detectExternalCallInLoop(
	index: SourceIndex,
): DetectedPattern[] {
	const patterns: DetectedPattern[] = [];

	for (const obj of index.objects.values()) {
		const members = [...obj.procedures, ...obj.triggers];
		for (const member of members) {
			for (const call of member.features.externalCallsInLoops) {
				if (!call.insideLoop) continue;
				// A Sleep in a wait loop IS the wait — see isDataDrivenLoopAt.
				// Still reported, so the delay stays visible, but at info: the
				// critical rating and the "remove it" advice are both wrong for
				// a backoff or a throttle.
				const isDeliberateWait =
					call.type === "Sleep" && !isDataDrivenLoopAt(member, call.line);
				const severity: PatternSeverity = isDeliberateWait
					? "info"
					: downgradePageImplicitLoop("critical", call);
				const costPhrase = isDeliberateWait
					? "The loop terminates on a condition rather than on running out of rows, so this delay is a deliberate wait — a backoff or a throttle — not a per-row cost"
					: call.type === "Sleep"
						? "Each iteration blocks for the full delay, multiplying total run time by the iteration count"
						: "Each iteration is a separate network round-trip";
				patterns.push({
					id: "external-call-in-loop",
					severity,
					title: `${call.type}() inside loop in ${member.name}`,
					description: `${call.type}() ${loopLocationPhrase(call, call.line, member.file)} in ${obj.objectType} ${obj.objectName} (${obj.objectId}). ${costPhrase}${isDeliberateWait ? "." : " — latency dominates everything else in the profile."}`,
					impact: 0,
					involvedMethods: [
						`${member.name} (${obj.objectType} ${obj.objectId})`,
					],
					evidence: `${call.type}() at line ${call.line}, column ${call.column} — ${loopEvidencePhrase(call)}`,
					suggestion: isDeliberateWait
						? "Confirm the wait is bounded — an unbounded retry or throttle loop can block a session indefinitely. If it is bounded, nothing needs changing here."
						: call.type === "Sleep"
							? "Remove Sleep() from the loop, or hoist it outside — a fixed delay per iteration multiplies directly by the iteration count."
							: "Hoist the call outside the loop, or batch the payload into a single request — N iterations means N round-trips, and network latency dominates everything else in the profile.",
				});
			}
		}
	}

	return patterns;
}

/**
 * Object types whose members can reference a record named `Rec` with no
 * declaration anywhere — the object's own source record. Report/XMLport are
 * absent on purpose: their implicit record is the dataitem's instance name,
 * never the literal `Rec`.
 */
const IMPLICIT_REC_OBJECT_TYPES = new Set([
	"Table",
	"TableExtension",
	"Page",
	"PageExtension",
]);

/** True if `field` is the leading (first) field of any key on `table`. */
function isKeyLeadingField(table: ResolvedTable, field: string): boolean {
	const target = field.toLowerCase();
	return table.keys.some(
		(k) => k.key.fields.length > 0 && k.key.fields[0].toLowerCase() === target,
	);
}

/**
 * Detect SetRange/SetFilter on fields not covered by any key in the target table.
 * Requires: table keys (3.7), variable type resolution (3.3).
 * Severity: warning.
 *
 * A filter is only a scan risk if *no* filter on that record variable hits a
 * key's leading field. When a sibling filter in the same member does, SQL seeks
 * that key and the remaining filters are residual predicates evaluated over the
 * seek result — flagging them is a false positive. Filters accumulate on the
 * record independently of source order, so sibling position is not checked.
 *
 * Deliberately conservative: a sibling in a mutually exclusive branch (an
 * if/else arm) still suppresses, trading recall for precision, since this
 * detector's measured false-positive rate is what motivated the sibling check.
 */
export function detectUnindexedFilters(index: SourceIndex): DetectedPattern[] {
	const FILTER_OPS = new Set(["SetRange", "SetFilter"]);
	const patterns: DetectedPattern[] = [];

	for (const obj of index.objects.values()) {
		const members = [...obj.procedures, ...obj.triggers];
		for (const member of members) {
			for (const op of member.features.recordOps) {
				if (!FILTER_OPS.has(op.type) || !op.fieldArgument || !op.recordVariable)
					continue;

				// Resolve record variable to table name
				const variable = member.features.variables.find(
					(v) => v.name.toLowerCase() === op.recordVariable!.toLowerCase(),
				);
				if (!variable?.isRecord || !variable.tableName || variable.isTemporary)
					continue;

				// The RESOLVED table: root declaration plus every indexed
				// tableextension. Before this, an extension's keys and
				// FlowFilter fields were invisible and each produced a false
				// finding.
				const tableObj = index.tables.get(variable.tableName.toLowerCase());
				// An ambiguous name is two different tables; neither answer is
				// about the one in hand.
				if (!tableObj || tableObj.ambiguous) continue;
				// "Does NO key lead with this field" is a NEGATIVE claim, and a
				// fragment cannot support it — an unseen root key could lead
				// with it. Same skip as the empty-keys case below, so partner
				// apps continue to get no unindexed-filter findings for base
				// tables. This change does not improve that.
				if (!tableObj.rootSeen) continue;
				if (tableObj.keys.length === 0) continue;

				// Fields that cannot produce the scan this detector warns about.
				// A FlowFilter is not a table column at all — it parameterises
				// FlowField calculation and has no index by definition — and
				// SystemId carries its own unique index in BC. On a 15,436-file
				// corpus "Date Filter" was the single most-flagged field (450 of
				// 10,352) with SystemId another 147.
				const filteredLower = op.fieldArgument.toLowerCase();
				if (filteredLower === "systemid") continue;
				const fieldDef = tableObj.fields.find(
					(f) => f.name.toLowerCase() === filteredLower,
				);
				if (fieldDef?.fieldClass?.toLowerCase() === "flowfilter") continue;

				// Check if any key has the filtered field as a leading (first) field
				if (isKeyLeadingField(tableObj, op.fieldArgument)) continue;

				// A sibling filter on the same record variable that does hit a
				// key's leading field makes this one a residual predicate, not a scan.
				const recordVariable = op.recordVariable.toLowerCase();
				const coveredBySibling = member.features.recordOps.some(
					(sibling) =>
						sibling !== op &&
						FILTER_OPS.has(sibling.type) &&
						sibling.fieldArgument !== undefined &&
						sibling.recordVariable?.toLowerCase() === recordVariable &&
						isKeyLeadingField(tableObj, sibling.fieldArgument),
				);

				if (!coveredBySibling) {
					patterns.push({
						id: "unindexed-filter",
						severity: "warning",
						title: `${op.type} on "${op.fieldArgument}" has no supporting key in ${variable.tableName}`,
						description: `${op.type}("${op.fieldArgument}", ...) on ${op.recordVariable} at line ${op.line} in ${member.file} filters on a field that is not the leading field of any key on table "${variable.tableName}". This may cause a full table scan.`,
						impact: 0,
						involvedMethods: [memberLabel(member)],
						// Keys carry their contributor because an extension may
						// legally reuse a base key's NAME. Without the tag the
						// evidence renders one name twice with two different
						// field lists and reads as a tool bug rather than as the
						// legal AL shape it is.
						evidence: `${op.type}("${op.fieldArgument}") at line ${op.line}; keys: ${tableObj.keys
							.map(
								(k) =>
									`${k.key.name}(${k.key.fields.join(", ")})${
										k.fromObjectId === tableObj.objectId
											? ""
											: ` [from extension ${k.fromObjectId}]`
									}`,
							)
							.join(", ")}`,
						suggestion: `Add a key starting with "${op.fieldArgument}" to table "${variable.tableName}", or restructure the query to filter on an existing key's leading field.`,
					});
				}
			}
		}
	}

	return patterns;
}

/**
 * Run all source-only pattern detectors and return results sorted by impact descending.
 */
export function runSourceOnlyDetectors(index: SourceIndex): DetectedPattern[] {
	const allPatterns: DetectedPattern[] = [
		...detectNestedLoops(index),
		...detectUnfilteredFindSet(index),
		...detectEventSubscriberIssues(index),
		...detectDangerousCallsInLoop(index),
		...detectExternalCallInLoop(index),
		...detectUnindexedFilters(index),
	];

	return sortPatterns(allPatterns);
}
