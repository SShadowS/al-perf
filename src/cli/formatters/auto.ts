export type OutputFormat = "terminal" | "json" | "markdown" | "html" | "auto";

export function resolveFormat(format: OutputFormat): "terminal" | "json" | "markdown" | "html" {
  if (format !== "auto") return format;
  return process.stdout.isTTY ? "terminal" : "json";
}
