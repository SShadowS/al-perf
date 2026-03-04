import { Parser, Language, Tree } from "web-tree-sitter";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, writeFileSync } from "fs";

const WASM_URL =
  "https://github.com/SShadowS/tree-sitter-al/releases/download/latest/tree-sitter-al.wasm";

let cachedParser: Parser | null = null;

/**
 * Ensure the tree-sitter-al WASM file exists locally.
 * Downloads it from the GitHub release if missing.
 */
async function ensureWasm(wasmPath: string): Promise<void> {
  if (existsSync(wasmPath)) return;

  console.error("tree-sitter-al.wasm not found — downloading from GitHub...");
  const res = await fetch(WASM_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to download tree-sitter-al.wasm (${res.status}). ` +
        `Download it manually from: ${WASM_URL}`,
    );
  }
  writeFileSync(wasmPath, Buffer.from(await res.arrayBuffer()));
  console.error("tree-sitter-al.wasm downloaded successfully.");
}

/**
 * Initialize and return a tree-sitter parser configured with the AL language.
 * The parser is cached so subsequent calls return the same instance.
 * Downloads the WASM file automatically if not present.
 */
export async function createALParser(): Promise<Parser> {
  if (cachedParser) return cachedParser;

  await Parser.init();
  const parser = new Parser();

  // Resolve WASM path relative to this file
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const wasmPath = resolve(thisDir, "tree-sitter-al.wasm");

  await ensureWasm(wasmPath);

  const AL = await Language.load(wasmPath);
  parser.setLanguage(AL);

  cachedParser = parser;
  return parser;
}

/**
 * Parse AL source code and return the syntax tree.
 * Initializes the parser on first call.
 */
export async function parseALSource(source: string): Promise<Tree> {
  const parser = await createALParser();
  return parser.parse(source) as Tree;
}
