import { describe, expect, test } from "bun:test";
import {
	parseAlStackFrame,
	telemetryRoutineKey,
} from "../../src/lifecycle/telemetry-sql.js";

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

	test("regression: rejects fake frames before AL CallStack marker", () => {
		const stack =
			'AppObjectType: Table\r\n  AppObjectId: 50100\r\n  SomeHeader: "Fake Name"(Table 1).NotTheRealMethod\r\n  AL CallStack: "Sample Job"(Table 50100).Run line 60 - Sample Extension';
		expect(parseAlStackFrame(stack)).toBe("Run");
	});

	test("regression: handles Report as object type", () => {
		const stack =
			'AL CallStack: "Sales Report"(Report 50200).OnPreReport line 10';
		expect(parseAlStackFrame(stack)).toBe("OnPreReport");
	});

	test("regression: extracts method names with digits and underscores", () => {
		const stack =
			'AL CallStack: "Post Mgmt"(CodeUnit 50400).Post_Line2 line 25 - Sample Extension';
		expect(parseAlStackFrame(stack)).toBe("Post_Line2");
	});

	test("regression: handles object names with dots and parentheses", () => {
		const stack =
			'AL CallStack: "CTS-SYS Send (Daily) Tel."(CodeUnit 50300).Emit line 15 - Sample Extension';
		expect(parseAlStackFrame(stack)).toBe("Emit");
	});

	test("regression: takes first frame after marker even if inline frame absent", () => {
		const stack =
			'AppObjectType: Report\r\nAppObjectId: 840\r\nAL CallStack:\r\n"Report Handler"(CodeUnit 50500).ProcessReport line 30 - Sample Extension';
		expect(parseAlStackFrame(stack)).toBe("ProcessReport");
	});
});

describe("telemetryRoutineKey", () => {
	test("is stable across object-type casing and trigger spelling", () => {
		const a = telemetryRoutineKey("ABC", "CodeUnit", 80, "OnRun");
		const b = telemetryRoutineKey("abc", "codeunit", 80, "onrun");
		expect(a).toBe(b);
	});

	test("distinguishes different routines on the same object", () => {
		expect(telemetryRoutineKey("abc", "CodeUnit", 80, "PostLines")).not.toBe(
			telemetryRoutineKey("abc", "CodeUnit", 80, "PostHeader"),
		);
	});

	test("distinguishes different objects", () => {
		expect(telemetryRoutineKey("abc", "CodeUnit", 80, "OnRun")).not.toBe(
			telemetryRoutineKey("abc", "CodeUnit", 81, "OnRun"),
		);
	});

	test("does NOT include the signal id — RT0005 evidence must reach RT0018 findings", () => {
		// Same routine, different signals => same key by construction: the key
		// takes no signalId parameter at all.
		expect(telemetryRoutineKey.length).toBe(4);
	});
});
