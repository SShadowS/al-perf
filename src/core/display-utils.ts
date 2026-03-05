/**
 * Utilities for formatting function names in display output.
 */

/**
 * Check whether a function name looks like a raw SQL statement
 * (common in BC profiler output for direct DB calls).
 */
export function isSqlStatement(name: string): boolean {
  const upper = name.trimStart().toUpperCase();
  return (
    upper.startsWith("SELECT ") ||
    upper.startsWith("INSERT ") ||
    upper.startsWith("UPDATE ") ||
    upper.startsWith("DELETE ") ||
    upper.startsWith("IF EXISTS(SELECT") ||
    upper.startsWith("EXEC ") ||
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
