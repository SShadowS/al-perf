import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { IRJSON_SCHEMA_VERSION } from "../../src/types/irjson.js";

const FIXTURES = "test/fixtures";

describe("ir-json schemaVersion contract pin", () => {
	test("the pin is schemaVersion 1", () => {
		expect(IRJSON_SCHEMA_VERSION).toBe(1);
	});

	test("committed real bc-mdc-converter output matches the pin", () => {
		const gz = readFileSync(`${FIXTURES}/tiny.ir.json.gz`);
		const doc = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(gz)));
		expect(doc.schemaVersion).toBe(IRJSON_SCHEMA_VERSION);
		expect(doc.generator.name).toBe("bc-mdc-converter");
		expect(doc.capture.ticksPerMs).toBe(10000);
		expect(doc.capture.invocationCount).toBe(1639);
		expect(doc.invocations).toHaveLength(1639);
	});

	test("committed minimal fixture matches the pin", () => {
		const doc = JSON.parse(
			readFileSync(`${FIXTURES}/irjson-minimal.ir.json`, "utf8"),
		);
		expect(doc.schemaVersion).toBe(IRJSON_SCHEMA_VERSION);
		expect(doc.capture.invocationCount).toBe(7);
		expect(doc.capture.incompleteCount).toBe(1);
		expect(doc.capture.exceptionCount).toBe(1);
	});
});

describe("library API surface", () => {
	test("ir-json parser and pin are exported from the package root", async () => {
		const api = await import("../../src/index.js");
		expect(typeof api.parseIrJson).toBe("function");
		expect(typeof api.isIrJsonDocument).toBe("function");
		expect(api.IRJSON_SCHEMA_VERSION).toBe(1);
	});
});
