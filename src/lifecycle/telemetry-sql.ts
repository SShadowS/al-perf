/**
 * telemetry-sql.ts — pure logic for the telemetry SQL evidence layer: AL stack
 * parsing, the routine join key, statement redaction, and the statement→signal
 * join. No I/O and no KQL; `appinsights.ts` calls into this module so SQL-shape
 * knowledge stays out of the adapter and every rule here is unit-testable
 * without a fetch mock.
 */

/**
 * The AL frame grammar, verified against real RT0005 rows in Gate 0:
 *   "<Object Name>"(<ObjectType> <ObjectId>).<Method> line <N> - <app info>
 * Header lines (`AppObjectType:`, `AppObjectId:`) precede `AL CallStack:` and
 * are NOT frames — taking line 0 (the pre-fix behavior) yields a header string,
 * never a method.
 */
const AL_FRAME_RE = /"[^"]*"\([A-Za-z]+\s+\d+\)\.([A-Za-z_][\w]*)/;

export function parseAlStackFrame(stack: string): string | null {
	if (!stack) return null;
	const match = AL_FRAME_RE.exec(stack);
	return match ? match[1] : null;
}
