// Local session metadata and event history store.
// Enriches platform session data with local-only fields like summaries,
// and persists session events so they survive component unmounts and
// server restarts. Stored in the existing SQLite database.

import type { Database } from "db0";
import type { SessionEvent } from "@/types";
import { getAppDatabase } from "../database";

export type LocalSessionMetadata = {
  sessionId: string;
  summary: string;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
};

type SessionMetadataRow = {
  session_id: string;
  summary: string;
  created_at: string;
  updated_at: string;
};

function mapRow(row: SessionMetadataRow): LocalSessionMetadata {
  return {
    sessionId: row.session_id,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

let instance: SessionMetadataStore | undefined;

export async function getSessionMetadataStore(): Promise<SessionMetadataStore> {
  if (!instance) {
    const db = await getAppDatabase();
    instance = new SessionMetadataStore(db);
    await instance.ensureTable();
  }
  return instance;
}

export class SessionMetadataStore {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async ensureTable(): Promise<void> {
    await this.#db.exec(`
      CREATE TABLE IF NOT EXISTS session_metadata (
        session_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    await this.#db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        event_index INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, run_id, event_index)
      )
    `);

    // Migrate: if existing table has wrong PK (missing run_id), rebuild it.
    // This happens when session_events was created before run_id was added.
    await this.#migrateSessionEventsPrimaryKey();
  }

  /**
   * If the session_events table's PRIMARY KEY doesn't include run_id
   * (legacy schema), rebuild the table with the correct composite key.
   */
  async #migrateSessionEventsPrimaryKey(): Promise<void> {
    try {
      // Check if run_id is part of the primary key by inspecting the CREATE TABLE SQL
      const { rows } = await this.#db.sql`
        SELECT sql FROM sqlite_master WHERE type='table' AND name='session_events'
      `;
      const createSql = (rows as Array<{ sql: string }>)[0]?.sql ?? "";

      // If the PK already includes run_id, no migration needed
      if (createSql.includes("run_id") && createSql.includes("PRIMARY KEY")) {
        // Check if run_id appears BEFORE "PRIMARY KEY" in the CREATE statement,
        // which means it was defined as a column but might not be in the PK.
        // A more reliable check: look for run_id within the PRIMARY KEY clause.
        const pkMatch = createSql.match(/PRIMARY KEY\s*\(([^)]+)\)/i);
        if (pkMatch && pkMatch[1].includes("run_id")) {
          return; // Already has correct PK
        }
      }

      console.log("[sessionStore] Migrating session_events to include run_id in PRIMARY KEY...");

      await this.#db.exec("BEGIN IMMEDIATE");
      try {
        // Add run_id column if it doesn't exist yet
        try {
          await this.#db.exec(
            `ALTER TABLE session_events ADD COLUMN run_id TEXT NOT NULL DEFAULT ''`,
          );
        } catch {
          // Column already exists
        }

        await this.#db.exec(`
          CREATE TABLE session_events_new (
            session_id TEXT NOT NULL,
            run_id TEXT NOT NULL DEFAULT '',
            event_index INTEGER NOT NULL,
            event_json TEXT NOT NULL,
            PRIMARY KEY (session_id, run_id, event_index)
          )
        `);
        await this.#db.exec(`
          INSERT INTO session_events_new (session_id, run_id, event_index, event_json)
          SELECT session_id, COALESCE(run_id, ''), event_index, event_json FROM session_events
        `);
        await this.#db.exec(`DROP TABLE session_events`);
        await this.#db.exec(`ALTER TABLE session_events_new RENAME TO session_events`);
        await this.#db.exec("COMMIT");
        console.log("[sessionStore] Migration complete.");
      } catch (err) {
        try {
          await this.#db.exec("ROLLBACK");
        } catch {
          // ignore
        }
        throw err;
      }
    } catch (err) {
      console.error("[sessionStore] PK migration failed (non-fatal):", err);
    }
  }

  // ── Session metadata ──────────────────────────────────────────────────

  /** Get metadata for a single session */
  async get(sessionId: string): Promise<LocalSessionMetadata | null> {
    const { rows } = await this.#db.sql`
      SELECT * FROM session_metadata WHERE session_id = ${sessionId}
    `;
    const row = (rows as SessionMetadataRow[])[0];
    return row ? mapRow(row) : null;
  }

  /** Get metadata for all sessions */
  async getAll(): Promise<LocalSessionMetadata[]> {
    const { rows } = await this.#db.sql`
      SELECT * FROM session_metadata ORDER BY updated_at DESC
    `;
    return (rows as SessionMetadataRow[]).map(mapRow);
  }

  /** Get metadata for specific session IDs */
  async getByIds(sessionIds: string[]): Promise<Map<string, LocalSessionMetadata>> {
    const result = new Map<string, LocalSessionMetadata>();
    if (sessionIds.length === 0) return result;

    for (const sessionId of sessionIds) {
      const meta = await this.get(sessionId);
      if (meta) result.set(sessionId, meta);
    }
    return result;
  }

  /** Create or update session metadata */
  async upsert(sessionId: string, summary: string): Promise<void> {
    const now = new Date().toISOString();
    await this.#db.sql`
      INSERT INTO session_metadata (session_id, summary, created_at, updated_at)
      VALUES (${sessionId}, ${summary}, ${now}, ${now})
      ON CONFLICT(session_id) DO UPDATE SET
        summary = ${summary},
        updated_at = ${now}
    `;
  }

  /** Update just the summary for a session */
  async updateSummary(
    sessionId: string,
    summary: string,
    options?: { replace?: boolean },
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.get(sessionId);

    if (!existing) {
      await this.upsert(sessionId, summary);
      return;
    }

    const newSummary = options?.replace ? summary : existing.summary || summary;
    await this.#db.sql`
      UPDATE session_metadata SET summary = ${newSummary}, updated_at = ${now}
      WHERE session_id = ${sessionId}
    `;
  }

  /** Delete metadata for a session */
  async delete(sessionId: string): Promise<void> {
    await this.#db.sql`DELETE FROM session_metadata WHERE session_id = ${sessionId}`;
    await this.#db.sql`DELETE FROM session_events WHERE session_id = ${sessionId}`;
  }

  // ── Session events ──────────────────────────────────────────────────

  /** Append a session event to persistent storage */
  async appendEvent(
    sessionId: string,
    runId: string,
    eventIndex: number,
    event: SessionEvent,
  ): Promise<void> {
    const eventJson = JSON.stringify(event);
    try {
      await this.#db.sql`
        INSERT OR REPLACE INTO session_events (session_id, run_id, event_index, event_json)
        VALUES (${sessionId}, ${runId}, ${eventIndex}, ${eventJson})
      `;
    } catch (err) {
      console.error(`[sessionStore] appendEvent failed for ${sessionId}:${eventIndex}:`, err);
      throw err;
    }
  }

  /** Atomically append all events for a run (consolidated messages after invocation). */
  async appendRunEvents(sessionId: string, runId: string, events: SessionEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.#db.exec("BEGIN IMMEDIATE");
      for (let i = 0; i < events.length; i++) {
        const eventJson = JSON.stringify(events[i]);
        await this.#db.sql`
          INSERT OR REPLACE INTO session_events (session_id, run_id, event_index, event_json)
          VALUES (${sessionId}, ${runId}, ${i}, ${eventJson})
        `;
      }
      await this.#db.exec("COMMIT");
    } catch (err) {
      try {
        await this.#db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures if the transaction has already ended.
      }
      console.error(`[sessionStore] appendRunEvents failed for ${sessionId}/${runId}:`, err);
      throw err;
    }
  }

  /** Append events to an existing run, continuing from the max event_index. */
  async appendToRun(sessionId: string, runId: string, events: SessionEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.#db.exec("BEGIN IMMEDIATE");
      // Find current max event_index for this run
      const { rows } = await this.#db.sql`
        SELECT COALESCE(MAX(event_index), -1) as max_idx
        FROM session_events WHERE session_id = ${sessionId} AND run_id = ${runId}
      `;
      const startIndex = ((rows as Array<{ max_idx: number }>)[0]?.max_idx ?? -1) + 1;
      for (let i = 0; i < events.length; i++) {
        const eventJson = JSON.stringify(events[i]);
        const idx = startIndex + i;
        await this.#db.sql`
          INSERT INTO session_events (session_id, run_id, event_index, event_json)
          VALUES (${sessionId}, ${runId}, ${idx}, ${eventJson})
        `;
      }
      await this.#db.exec("COMMIT");
    } catch (err) {
      try {
        await this.#db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures
      }
      console.error(`[sessionStore] appendToRun failed for ${sessionId}/${runId}:`, err);
      throw err;
    }
  }

  /** Load all events for a session, ordered by run_id then event_index */
  async loadEvents(sessionId: string): Promise<{ runId: string; events: SessionEvent[] }[]> {
    const { rows } = await this.#db.sql`
      SELECT run_id, event_json FROM session_events
      WHERE session_id = ${sessionId}
      ORDER BY rowid ASC
    `;
    const typed = rows as Array<{ run_id: string; event_json: string }>;

    // Group events by run_id, preserving insertion order
    const runs: { runId: string; events: SessionEvent[] }[] = [];
    let currentRun: { runId: string; events: SessionEvent[] } | null = null;

    for (const row of typed) {
      if (!currentRun || currentRun.runId !== row.run_id) {
        currentRun = { runId: row.run_id, events: [] };
        runs.push(currentRun);
      }
      currentRun.events.push(JSON.parse(row.event_json));
    }

    return runs;
  }

  /** Load all events for a session as a flat list (for backward compat) */
  async loadAllEvents(sessionId: string): Promise<SessionEvent[]> {
    const runs = await this.loadEvents(sessionId);
    return runs.flatMap((r) => r.events);
  }

  /** Clear events for a session (for new turn when reuseSession) */
  async clearEvents(sessionId: string): Promise<void> {
    await this.#db.sql`DELETE FROM session_events WHERE session_id = ${sessionId}`;
  }
}
