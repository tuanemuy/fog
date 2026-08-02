import { CHUNK_BUDGETS } from "@repo/core/lib/jobBudgets";
import { upsertSearchEntry } from "../../search/projection";
import { all, type Sql } from "../../sql/exec";
import { createUserDataContext } from "../../userData/unitOfWork";
import type { JobHandler, UserDataJobContext } from "../registry";
import type { JobRow } from "../table";

/**
 * Rebuilds the FTS5 side of the search index from `search_entries`, one chunk
 * at a time.
 *
 * **`INSERT INTO search_fts(search_fts) VALUES('rebuild')` is not used.** It is
 * a single unbounded statement over the whole index, so on a large DO it either
 * exceeds the alarm's CPU budget — which is an eviction, not an exception, so
 * nothing catches it and nothing resumes — or trips the statement limits. The
 * chunked form costs more statements and is the only form that can be stopped
 * and resumed.
 *
 * Each row is re-projected through `upsertSearchEntry`, which subtracts the old
 * terms with the FTS5 `'delete'` command before inserting the new ones. Passing
 * the row's own stored values therefore leaves `search_entries` untouched while
 * making the index side idempotent — running the same chunk twice is a no-op
 * rather than a double-index, which is what at-least-once execution requires.
 */

const STEP_NAME = "reindex";

type EntryRow = {
  rowid: number;
  id: string;
  type: string;
  topic_id: string | null;
  title: string;
  body: string;
  timestamp: number;
  source_ids: string;
};

/** Version 0 stands for a reindex asked for outside a migration. */
function readTargetVersion(row: JobRow): number {
  const payload = JSON.parse(row.payload) as {
    targetVersion?: unknown;
  } | null;
  return typeof payload?.targetVersion === "number" ? payload.targetVersion : 0;
}

function readStoredCursor(sql: Sql, targetVersion: number): number {
  const rows = all<{ cursor: string }>(
    sql,
    "SELECT cursor FROM migration_progress WHERE target_version = ? AND step = ?",
    targetVersion,
    STEP_NAME,
  );
  const parsed = Number(rows[0]?.cursor ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

export const reindex: JobHandler<UserDataJobContext> = async (context, row) => {
  const { ctx, sql, now } = context;
  const budget = CHUNK_BUDGETS.reindex;
  const targetVersion = readTargetVersion(row);
  const uow = createUserDataContext(sql, () => now);

  let cursor = readStoredCursor(sql, targetVersion);

  for (let chunk = 0; chunk < budget.maxChunks; chunk += 1) {
    const rows = all<EntryRow>(
      sql,
      `SELECT rowid, id, type, topic_id, title, body, timestamp, source_ids
         FROM search_entries
        WHERE rowid > ?
        ORDER BY rowid
        LIMIT ?`,
      cursor,
      budget.chunkRowLimit,
    );
    if (rows.length === 0) return { kind: "done" };

    const last = rows[rows.length - 1];
    if (last === undefined) return { kind: "done" };

    // The re-projection and the cursor that records it commit together: a DO
    // reset between them would otherwise re-run a chunk that already ran, and
    // although the projection tolerates that, the progress report would lie.
    ctx.storage.transactionSync(() => {
      for (const entry of rows) {
        upsertSearchEntry(sql, {
          id: entry.id,
          type: entry.type === "memo" ? "memo" : "document",
          topicId: entry.topic_id,
          title: entry.title,
          body: entry.body,
          timestamp: entry.timestamp,
          sourceIds: JSON.parse(entry.source_ids) as readonly string[],
        });
      }
      uow.setMigrationCursor(targetVersion, STEP_NAME, String(last.rowid));
    });
    cursor = last.rowid;
  }

  // Chunk budget spent with rows still ahead: hand the row back rather than
  // running on. Bounded by row count and never by elapsed time — `Date.now()`
  // does not advance reliably inside a CPU-bound run.
  return { kind: "yield" };
};
