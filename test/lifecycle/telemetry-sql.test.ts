import { describe, expect, test } from "bun:test";
import { parseAlStackFrame } from "../../src/lifecycle/telemetry-sql.js";

describe("parseAlStackFrame", () => {
	test("extracts the method from the first AL CallStack frame", () => {
		const stack =
			'AppObjectType: CodeUnit\r\nAppObjectId: 80\r\nAL CallStack: "Sales-Post"(CodeUnit 80).PostLines line 42 - Base Application by Microsoft';
		expect(parseAlStackFrame(stack)).toBe("PostLines");
	});

	test("takes the FIRST frame when several are present", () => {
		const stack =
			'AL CallStack: "Sales-Post"(CodeUnit 80).PostLines line 42\r\n"Sales-Post"(CodeUnit 80).OnRun line 7';
		expect(parseAlStackFrame(stack)).toBe("PostLines");
	});

	test("handles a trigger frame", () => {
		const stack =
			'AppObjectType: Table\r\nAL CallStack: "Sales Line"(Table 37).OnValidate line 3 - Base Application';
		expect(parseAlStackFrame(stack)).toBe("OnValidate");
	});

	test("returns null for a header-only stack — the bug this replaces", () => {
		expect(
			parseAlStackFrame("AppObjectType: Report\r\nAppObjectId: 840"),
		).toBeNull();
	});

	test("returns null for empty input", () => {
		expect(parseAlStackFrame("")).toBeNull();
	});
});
