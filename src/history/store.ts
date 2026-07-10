import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import type { AnalysisResult } from "../output/types.js";
import type { HistoryEntry, HistoryQuery } from "../types/history.js";

const TOMBSTONE = "MIGRATED.md";

/**
 * SQLite-backed store for analysis history (bun:sqlite, WAL).
 *
 * Lives in the SAME database file as the lifecycle engine (default
 * `.al-perf/lifecycle.sqlite`) — one persistence system (umbrella spec §4).
 * Opens its own connection and owns only the history_entries table, so it
 * also works standalone.
 *
 * Legacy migration: pass `legacyDir` (the old JSON-file store directory,
 * default `.al-perf-history` at the call sites). Entries are imported once;
 * a MIGRATED.md tombstone marks completion and the JSON files are kept as a
 * backup — never deleted.
 */
export class HistoryStore {
	private db: Database;

	constructor(dbPath: string, options?: { legacyDir?: string }) {
		const resolved = dbPath === ":memory:" ? dbPath : resolve(dbPath);
		if (resolved !== ":memory:") {
			mkdirSync(dirname(resolved), { recursive: true });
		}
		this.db = new Database(resolved, { create: true });
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run(`CREATE TABLE IF NOT EXISTS history_entries (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			profile_path TEXT NOT NULL,
			label TEXT,
			entry_json TEXT NOT NULL
		)`);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_history_time ON history_entries(timestamp)",
		);
		if (options?.legacyDir) this.migrateLegacyDir(options.legacyDir);
	}

	private migrateLegacyDir(dir: string): void {
		const legacy = resolve(dir);
		if (!existsSync(legacy)) return;
		if (existsSync(join(legacy, TOMBSTONE))) return;
		let migrated = 0;
		for (const file of readdirSync(legacy).filter((f) => f.endsWith(".json"))) {
			try {
				const entry: HistoryEntry = JSON.parse(
					readFileSync(join(legacy, file), "utf-8"),
				);
				const res = this.insertEntry(entry, true);
				if (res) migrated++;
			} catch {
				// Skip corrupted files — same policy as the old JSON store.
			}
		}
		writeFileSync(
			join(legacy, TOMBSTONE),
			`# Migrated\n\nThese JSON history entries were imported into the SQLite history store on ${new Date().toISOString()} (${migrated} entries).\nThe files are kept as a backup; the history CLI/MCP tools now read from the database.\nDelete this directory when you no longer need the backup.\n`,
			"utf-8",
		);
	}

	private insertEntry(entry: HistoryEntry, ignoreDupes: boolean): boolean {
		const res = this.db.run(
			`INSERT ${ignoreDupes ? "OR IGNORE " : ""}INTO history_entries (id, timestamp, profile_path, label, entry_json)
			 VALUES (?, ?, ?, ?, ?)`,
			[
				entry.id,
				entry.timestamp,
				entry.profilePath,
				entry.label ?? null,
				JSON.stringify(entry),
			],
		);
		return res.changes > 0;
	}

	/** Store an analysis result as a history entry. */
	save(
		result: AnalysisResult,
		options?: { gitCommit?: string; label?: string },
	): HistoryEntry {
		const timestamp = result.meta.analyzedAt;
		const profileHash = createHash("sha256")
			.update(result.meta.profilePath)
			.digest("hex")
			.slice(0, 8);
		const baseId = `${timestamp.replace(/[:.]/g, "-")}_${profileHash}`;

		// Ensure uniqueness: append a counter while the id exists.
		let id = baseId;
		let counter = 1;
		while (this.get(id) !== null) {
			id = `${baseId}_${counter}`;
			counter++;
		}

		const entry: HistoryEntry = {
			id,
			timestamp,
			profilePath: result.meta.profilePath,
			profileType: result.meta.profileType,
			gitCommit: options?.gitCommit,
			label: options?.label,
			metrics: {
				totalDuration: result.meta.totalDuration,
				totalSelfTime: result.meta.totalSelfTime,
				idleSelfTime: result.meta.idleSelfTime,
				nodeCount: result.meta.totalNodes,
				maxDepth: result.meta.maxDepth,
				confidenceScore: result.meta.confidenceScore,
				healthScore: result.summary.healthScore,
				patternCount: result.summary.patternCount,
			},
			topHotspots: result.hotspots.slice(0, 5).map((h) => ({
				functionName: h.functionName,
				objectType: h.objectType,
				objectId: h.objectId,
				selfTime: h.selfTime,
				selfTimePercent: h.selfTimePercent,
			})),
		};

		this.insertEntry(entry, false);
		return entry;
	}

	/** Query history entries with optional filters (newest first). */
	query(q?: HistoryQuery): HistoryEntry[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (q?.profilePath) {
			where.push("instr(lower(profile_path), lower(?)) > 0");
			params.push(q.profilePath);
		}
		if (q?.since) {
			where.push("timestamp >= ?");
			params.push(q.since);
		}
		if (q?.until) {
			where.push("timestamp <= ?");
			params.push(q.until);
		}
		if (q?.label) {
			where.push("label = ?");
			params.push(q.label);
		}
		let sql = "SELECT entry_json FROM history_entries";
		if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
		sql += " ORDER BY timestamp DESC, id DESC";
		if (q?.limit !== undefined && q.limit > 0) {
			sql += " LIMIT ?";
			params.push(q.limit);
		}
		return this.db
			.query<{ entry_json: string }, (string | number)[]>(sql)
			.all(...params)
			.map((row) => JSON.parse(row.entry_json) as HistoryEntry);
	}

	/** Get a specific entry by ID. */
	get(id: string): HistoryEntry | null {
		const row = this.db
			.query<{ entry_json: string }, [string]>(
				"SELECT entry_json FROM history_entries WHERE id = ?",
			)
			.get(id);
		if (!row) return null;
		try {
			return JSON.parse(row.entry_json) as HistoryEntry;
		} catch {
			return null;
		}
	}

	/** Delete a specific entry. */
	delete(id: string): boolean {
		const res = this.db.run("DELETE FROM history_entries WHERE id = ?", [id]);
		return res.changes > 0;
	}

	/** Clear all history entries (rows only — the database file remains). */
	clearAll(): void {
		this.db.run("DELETE FROM history_entries");
	}

	/** Count total entries. */
	count(): number {
		const row = this.db
			.query<{ n: number }, []>("SELECT count(*) AS n FROM history_entries")
			.get();
		return row?.n ?? 0;
	}

	close(): void {
		this.db.close();
	}
}
