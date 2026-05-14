import { describe, expect, it } from "bun:test";
import { resolve } from "path";
import { findCompanionZip } from "../../src/source/zip-extractor.js";

const fixturesDir = resolve(import.meta.dir, "../fixtures");

describe("findCompanionZip", () => {
	it("should return null when no companion zip exists for sampling profile", () => {
		const profilePath = resolve(fixturesDir, "sampling-minimal.alcpuprofile");
		const zipPath = findCompanionZip(profilePath);
		expect(zipPath).toBeNull();
	});

	it("should return null when no companion zip exists for instrumentation profile", () => {
		const profilePath = resolve(
			fixturesDir,
			"instrumentation-minimal.alcpuprofile",
		);
		const zipPath = findCompanionZip(profilePath);
		expect(zipPath).toBeNull();
	});
});
