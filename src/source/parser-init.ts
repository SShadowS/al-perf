import { Parser, Language, Tree } from "web-tree-sitter";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

let cachedParser: Parser | null = null;

/**
 * Initialize and return a tree-sitter parser configured with the AL language.
 * The parser is cached so subsequent calls return the same instance.
 */
export async function createALParser(): Promise<Parser> {
  if (cachedParser) return cachedParser;

  await Parser.init();
  const parser = new Parser();

  // Resolve WASM path relative to this file
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const wasmPath = resolve(thisDir, "tree-sitter-al.wasm");

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
