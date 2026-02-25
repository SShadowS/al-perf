import { readFile } from "fs/promises";

export interface SnippetOptions {
  lineNumbers?: boolean;
  contextLines?: number;
}

/**
 * Extract a snippet of source code from a file.
 * @param filePath Absolute path to the source file
 * @param startLine 1-based start line
 * @param endLine 1-based end line
 */
export async function extractSnippet(
  filePath: string,
  startLine: number,
  endLine: number,
  options?: SnippetOptions,
): Promise<string> {
  const source = await readFile(filePath, "utf-8");
  const allLines = source.split("\n");

  const context = options?.contextLines ?? 0;
  const actualStart = Math.max(1, startLine - context);
  const actualEnd = Math.min(allLines.length, endLine + context);

  const lines = allLines.slice(actualStart - 1, actualEnd);

  if (options?.lineNumbers) {
    const padWidth = String(actualEnd).length;
    return lines
      .map((line, i) => {
        const lineNum = String(actualStart + i).padStart(padWidth, " ");
        return `${lineNum}| ${line}`;
      })
      .join("\n");
  }

  return lines.join("\n");
}

/**
 * Annotate a snippet with markers on specific lines.
 * @param snippet The source snippet (plain text, no line numbers)
 * @param annotations Map from relative line number (1-based within snippet) to annotation text
 */
export function annotateSnippet(
  snippet: string,
  annotations: Map<number, string>,
): string {
  const lines = snippet.split("\n");
  const maxLen = Math.max(...lines.map((l) => l.length));
  const padTo = Math.min(maxLen + 2, 80);

  return lines
    .map((line, i) => {
      const relativeLineNum = i + 1;
      const annotation = annotations.get(relativeLineNum);
      if (annotation) {
        const padded = line.padEnd(padTo);
        return `${padded} \u2190 ${annotation}`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Read all lines of a source file and return them as an array.
 */
export async function readSourceLines(filePath: string): Promise<string[]> {
  const source = await readFile(filePath, "utf-8");
  return source.split("\n");
}
