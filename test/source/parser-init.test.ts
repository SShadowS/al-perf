import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
	AL_GRAMMAR_VERSION,
	createALParser,
	ensureWasm,
	parseALSource,
	WASM_URL,
} from "../../src/source/parser-init.js";

describe("createALParser", () => {
	it("should initialize a tree-sitter parser with AL language", async () => {
		const parser = await createALParser();
		expect(parser).toBeDefined();
	});
});

describe("parseALSource", () => {
	it("should parse a simple codeunit", async () => {
		const source = `codeunit 50100 "My Codeunit"
{
    procedure DoSomething()
    begin
        Message('Hello');
    end;
}`;
		const tree = await parseALSource(source);
		expect(tree).toBeDefined();
		expect(tree.rootNode.type).toBe("source_file");
		expect(tree.rootNode.namedChildCount).toBeGreaterThan(0);
	});

	it("should parse a table with trigger", async () => {
		const source = `table 50100 "My Table"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    trigger OnInsert()
    begin
    end;
}`;
		const tree = await parseALSource(source);
		expect(tree.rootNode.type).toBe("source_file");
	});
});

describe("grammar version pin", () => {
	function tempDir(): string {
		return mkdtempSync(join(tmpdir(), "alperf-wasm-"));
	}

	/** A fetch stand-in that records its calls and returns fixed bytes. */
	function fakeFetch(body = "WASM") {
		const calls: string[] = [];
		const impl = async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				status: 200,
				arrayBuffer: async () => new TextEncoder().encode(body).buffer,
			} as unknown as Response;
		};
		return { impl, calls };
	}

	it("names the pinned tag in the download URL, not 'latest'", () => {
		expect(WASM_URL).toContain(`/download/${AL_GRAMMAR_VERSION}/`);
		expect(WASM_URL).not.toContain("/latest/");
	});

	it("downloads and records the version when nothing is cached", async () => {
		const dir = tempDir();
		try {
			const wasmPath = resolve(dir, "tree-sitter-al.wasm");
			const { impl, calls } = fakeFetch();
			await ensureWasm(wasmPath, impl);
			expect(calls).toEqual([WASM_URL]);
			expect(readFileSync(wasmPath, "utf8")).toBe("WASM");
			expect(readFileSync(resolve(dir, "tree-sitter-al.version"), "utf8")).toBe(
				AL_GRAMMAR_VERSION,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not re-download when the cached version matches the pin", async () => {
		const dir = tempDir();
		try {
			const wasmPath = resolve(dir, "tree-sitter-al.wasm");
			writeFileSync(wasmPath, "CACHED");
			writeFileSync(resolve(dir, "tree-sitter-al.version"), AL_GRAMMAR_VERSION);
			const { impl, calls } = fakeFetch();
			await ensureWasm(wasmPath, impl);
			expect(calls).toEqual([]);
			expect(readFileSync(wasmPath, "utf8")).toBe("CACHED");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("re-downloads when the cached version is a different tag", async () => {
		const dir = tempDir();
		try {
			const wasmPath = resolve(dir, "tree-sitter-al.wasm");
			writeFileSync(wasmPath, "OLD");
			writeFileSync(resolve(dir, "tree-sitter-al.version"), "v2.6.0");
			const { impl, calls } = fakeFetch("NEW");
			await ensureWasm(wasmPath, impl);
			expect(calls).toEqual([WASM_URL]);
			expect(readFileSync(wasmPath, "utf8")).toBe("NEW");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("re-downloads a cached wasm that carries no version file at all", async () => {
		// Every install predating the pin is in this state: a wasm of unknown
		// provenance, fetched from /latest/ on whatever day it first ran. It
		// must be replaced, not trusted.
		const dir = tempDir();
		try {
			const wasmPath = resolve(dir, "tree-sitter-al.wasm");
			writeFileSync(wasmPath, "UNKNOWN");
			const { impl, calls } = fakeFetch("PINNED");
			await ensureWasm(wasmPath, impl);
			expect(calls).toEqual([WASM_URL]);
			expect(readFileSync(wasmPath, "utf8")).toBe("PINNED");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves no version file behind when the download fails", async () => {
		// A version file written next to a missing wasm would make the next run
		// believe the pinned grammar is already cached.
		const dir = tempDir();
		try {
			const wasmPath = resolve(dir, "tree-sitter-al.wasm");
			const failing = async () =>
				({ ok: false, status: 404 }) as unknown as Response;
			await expect(ensureWasm(wasmPath, failing)).rejects.toThrow(
				/tree-sitter-al\.wasm/,
			);
			expect(() =>
				readFileSync(resolve(dir, "tree-sitter-al.version"), "utf8"),
			).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
