/**
 * lifecycle-db.ts — process-wide LifecycleStore singleton for the web
 * server. One connection per DB path (opening per request would churn WAL
 * handles). The DB lives under the data root so it survives container
 * redeploys: <AL_PERF_DATA_DIR>/lifecycle.sqlite.
 */

import { join } from "path";
import { LifecycleStore } from "../src/lifecycle/store.ts";

const stores = new Map<string, LifecycleStore>();

export function getLifecycleStore(dataDir: string): LifecycleStore {
	const path = join(dataDir, "lifecycle.sqlite");
	let store = stores.get(path);
	if (!store) {
		store = new LifecycleStore(path);
		stores.set(path, store);
	}
	return store;
}

/**
 * Close and forget the singleton for one data dir. For tests only: a test
 * that mkdtemp's its own data dir must close the WAL handle before rmSync'ing
 * it, or deletion fails (EBUSY) on Windows. Production never calls this — the
 * whole point of the singleton is that the process keeps the handle open.
 */
export function closeLifecycleStoreForTest(dataDir: string): void {
	const path = join(dataDir, "lifecycle.sqlite");
	const store = stores.get(path);
	if (store) {
		store.close();
		stores.delete(path);
	}
}
