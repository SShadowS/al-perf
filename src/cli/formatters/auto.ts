export type OutputFormat = "terminal" | "json" | "auto";

export function resolveFormat(format: OutputFormat): "terminal" | "json" {
  if (format !== "auto") return format;
  return process.stdout.isTTY ? "terminal" : "json";
}
