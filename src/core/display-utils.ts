/**
 * Utilities for formatting function names in display output.
 */

/**
 * Check whether a function name looks like a raw SQL statement
 * (common in BC profiler output for direct DB calls).
 */
export function isSqlStatement(name: string): boolean {
	const upper = name.trimStart().toUpperCase();
	// The keyword may be followed by whitespace OR by punctuation: BC emits
	// statements it has already elided itself, in the form
	// `SELECT...WHERE ("Sales Line$0"."Document Type"=...)`. Requiring a space
	// after the keyword missed every one of those, so none of the formatters
	// truncated them and a 1,028-character statement went into a table cell
	// verbatim — in markdown, the format most likely to be pasted into a pull
	// request.
	return (
		/^(?:SELECT|INSERT|UPDATE|DELETE|EXEC)(?:\s|\.|\()/.test(upper) ||
		upper.startsWith("IF EXISTS(SELECT") ||
		upper.startsWith("BEGIN")
	);
}

/**
 * Truncate long SQL statement function names for display.
 * Non-SQL names are returned unchanged regardless of length.
 *
 * @param name     The function name to potentially truncate
 * @param maxLen   Maximum character length before truncation (default 120)
 * @returns        The original or truncated string (with trailing ellipsis)
 */
export function truncateFunctionName(name: string, maxLen = 120): string {
	if (name.length <= maxLen) return name;
	if (!isSqlStatement(name)) return name;
	return name.slice(0, maxLen) + "\u2026";
}
