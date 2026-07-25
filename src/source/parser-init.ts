import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { Language, Parser, type Tree } from "web-tree-sitter";

/**
 * The tree-sitter-al release this analyzer is built against. Grammar node
 * shapes have moved between major versions before (V1 -> V2 is why
 * `isPropertyNamed` exists in indexer.ts), so the grammar is a dependency
 * like any other and gets a version, not a moving `latest`.
 *
 * Bumping it: change this constant, run the suite. Every machine picks the
 * new grammar up on its next run, because the cached copy's recorded version
 * no longer matches.
 */
export const AL_GRAMMAR_VERSION = "v3.0.1";

export const WASM_URL = `https://github.com/SShadowS/tree-sitter-al/releases/download/${AL_GRAMMAR_VERSION}/tree-sitter-al.wasm`;

/** Sibling file recording which release the cached WASM came from. */
function versionPathFor(wasmPath: string): string {
	return resolve(dirname(wasmPath), "tree-sitter-al.version");
}

let cachedParser: Parser | null = null;

/**
 * Ensure the pinned tree-sitter-al WASM exists locally, downloading it when
 * it is missing or when the cached copy came from a different release.
 *
 * This used to be `if (existsSync(wasmPath)) return;` against a `latest`
 * URL, with no version recorded anywhere: whatever release happened to be
 * current the first time a machine ran `--source` was the grammar that
 * machine kept forever. Two developers who started on different days silently
 * parsed AL with different grammars, and CI got whatever shipped that morning.
 *
 * A cached WASM with no version file beside it is treated as unknown
 * provenance and replaced -- that is exactly the pre-pin state.
 *
 * The version file is written only AFTER the WASM lands, so a failed download
 * can never leave behind a marker claiming the pinned grammar is cached.
 */
export async function ensureWasm(
	wasmPath: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	const versionPath = versionPathFor(wasmPath);
	if (existsSync(wasmPath) && existsSync(versionPath)) {
		if (readFileSync(versionPath, "utf8").trim() === AL_GRAMMAR_VERSION) return;
	}

	console.error(
		`Downloading tree-sitter-al.wasm ${AL_GRAMMAR_VERSION} from GitHub...`,
	);
	const res = await fetchImpl(WASM_URL);
	if (!res.ok) {
		throw new Error(
			`Failed to download tree-sitter-al.wasm (${res.status}). ` +
				`Download it manually from: ${WASM_URL}`,
		);
	}
	writeFileSync(wasmPath, Buffer.from(await res.arrayBuffer()));
	writeFileSync(versionPath, AL_GRAMMAR_VERSION);
	console.error(`tree-sitter-al.wasm ${AL_GRAMMAR_VERSION} downloaded.`);
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
