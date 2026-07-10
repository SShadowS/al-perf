/**
 * cli.test.ts — lifecycle CLI: close guard (only from resolved), triage
 * toggling helper path, command registration. The evaluate/digest logic is
 * covered by evaluate.test.ts / digest.test.ts; here we test the CLI-owned
 * glue that isn't just commander wiring.
 */

import { describe, expect, it } from "bun:test";
import {
	applyClose,
	createLifecycleCommand,
	DEFAULT_DB_PATH,
} from "../../src/cli/commands/lifecycle.js";
import { LifecycleStore, type NewFinding } from "../../src/lifecycle/store.js";

function finding(state: NewFinding["state"]): NewFinding {
	return {
		tenant: "local",
		fingerprint: "pattern:cli0000000000001",
		algoVersion: 1,
		state,
		source: "pattern",
		patternId: "calcfields-in-loop",
		title: "x",
		severity: "warning",
		appId: "",
		appName: "",
		routineKey: "",
		firstSeenAt: "2026-07-01T00:00:00Z",
		lastSeenAt: "2026-07-01T00:00:00Z",
		lastEventAt: "2026-07-01T00:00:00Z",
		observedKinds: ["sampling"],
		observedStreams: ["adhoc"],
	};
}

describe("applyClose", () => {
	it("closes a resolved finding and logs the event", () => {
		const store = new LifecycleStore(":memory:");
		const id = store.insertFinding(finding("resolved"));
		const res = applyClose(
			store,
			"local",
			"pattern:cli0000000000001",
			"2026-07-09T00:00:00Z",
		);
		expect(res.ok).toBe(true);
		expect(store.getFinding(id)?.state).toBe("closed");
		expect(store.getFinding(id)?.closedAt).toBe("2026-07-09T00:00:00Z");
		expect(store.listEvents(id).at(-1)?.event).toBe("closed");
		store.close();
	});

	it("refuses to close a non-resolved finding (spec: close is human confirmation of resolved)", () => {
		const store = new LifecycleStore(":memory:");
		store.insertFinding(finding("open"));
		const res = applyClose(
			store,
			"local",
			"pattern:cli0000000000001",
			"2026-07-09T00:00:00Z",
		);
		expect(res.ok).toBe(false);
		expect(res.message).toContain("resolved");
		store.close();
	});

	it("reports a missing fingerprint", () => {
		const store = new LifecycleStore(":memory:");
		const res = applyClose(
			store,
			"local",
			"pattern:nope",
			"2026-07-09T00:00:00Z",
		);
		expect(res.ok).toBe(false);
		expect(res.message).toContain("No active finding");
		store.close();
	});
});

describe("createLifecycleCommand", () => {
	it("registers the command group with all subcommands", () => {
		const cmd = createLifecycleCommand();
		expect(cmd.name()).toBe("lifecycle");
		const subs = cmd.commands.map((c) => c.name());
		for (const s of [
			"evaluate",
			"digest",
			"status",
			"close",
			"triage",
			"maintain",
		]) {
			expect(subs).toContain(s);
		}
		expect(DEFAULT_DB_PATH).toBe(".al-perf/lifecycle.sqlite");
	});
});
