export type OutputFormat = "terminal" | "json" | "markdown" | "auto";

export function resolveFormat(format: OutputFormat): "terminal" | "json" | "markdown" {
  if (format !== "auto") return format;
  return process.stdout.isTTY ? "terminal" : "json";
}
