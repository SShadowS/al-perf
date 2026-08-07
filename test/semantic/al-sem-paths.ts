/**
 * al-sem-paths.ts — resolves the local al-sem engine checkout for gated real-binary tests.
 *
 * The semantic tests that exercise the REAL engine (rather than the stub) need two things
 * from a checkout that lives outside this repo: the release `alsem` binary and the
 * `tests/r0-corpus/` fixture workspaces. Those paths used to be written inline, three
 * times, as `U:/Git/al-call-hierarchy/...`.
 *
 * That broke twice over: the engine repo was renamed from `al-call-hierarchy` to `al-sem`
 * in August 2026, and a hardcoded absolute path only ever works on one machine anyway.
 * So resolution is now, in order:
 *
 *   1. `AL_SEM_REPO` — an explicit checkout root, if you have one somewhere else.
 *   2. `AL_SEM_BIN` — an explicit binary path (wins for the binary; the corpus still
 *      comes from the resolved root, since a binary path implies nothing about fixtures).
 *   3. The candidate roots below, first one that exists. Both directory spellings are
 *      probed, because renaming the GitHub repo did not rename anyone's local directory.
 *
 * Everything is best-effort and returns `undefined` when the checkout is absent — these
 * tests are GATED, not required. Callers use `test.skipIf(...)`, so a missing engine
 * skips the smoke tests rather than failing the suite.
 */

import { existsSync } from "fs";

/** Checkout roots probed in order, after the `AL_SEM_REPO` override. */
const CANDIDATE_ROOTS = ["U:/Git/al-sem", "U:/Git/al-call-hierarchy"] as const;

/** `alsem.exe` on Windows, `alsem` everywhere else. */
const BIN_NAME = process.platform === "win32" ? "alsem.exe" : "alsem";

function firstExisting(paths: Array<string | undefined>): string | undefined {
	for (const p of paths) {
		if (p && existsSync(p)) return p;
	}
	return undefined;
}

/**
 * The al-sem checkout root, or `undefined` when none is present.
 *
 * A root is accepted on existence alone; the binary and corpus are checked separately,
 * because a checkout that has never been built has the one without the other.
 */
export const AL_SEM_REPO: string | undefined = firstExisting([
	process.env.AL_SEM_REPO,
	...CANDIDATE_ROOTS,
]);

/**
 * The release `alsem` binary, or `undefined`.
 *
 * `AL_SEM_BIN` wins outright — that is the documented way to point at a freshly built
 * binary somewhere else (a worktree, a different profile directory).
 */
export const AL_SEM_BIN: string | undefined = firstExisting([
	process.env.AL_SEM_BIN,
	AL_SEM_REPO ? `${AL_SEM_REPO}/target/release/${BIN_NAME}` : undefined,
]);

/**
 * A named workspace under the engine's `tests/r0-corpus/`, or `undefined` when the
 * checkout or that fixture is missing.
 */
export function alSemCorpus(name: string): string | undefined {
	if (!AL_SEM_REPO) return undefined;
	const dir = `${AL_SEM_REPO}/tests/r0-corpus/${name}`;
	return existsSync(dir) ? dir : undefined;
}
