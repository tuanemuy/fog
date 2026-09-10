import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  UnitOfWorkRunner,
  UserDataUnitOfWorkContext,
} from "@repo/core/application/execution/unitOfWork";
import type { JobHandler } from "../jobRunner";
import { readMigrationCursor } from "../stores/migrationProgressStore";
import { projectDocument, reprojectMemo } from "../stores/searchProjection";

export const REINDEX_STEP = "reindex";

/** `jobs.operation_key` of the `reindex` a migration to `targetVersion` seeds: one row per version. */
export const reindexOperationKey = (targetVersion: number) =>
  `reindex:${targetVersion}`;

export type ReindexPayload = Readonly<{ targetVersion: number }>;

/**
 * Where the rebuild resumes: the last `(type, id)` re-projected, memos
 * before documents, or `done`. Ids are UUIDv7 strings, so `id > ?`
 * ascending is a total walk and the empty string starts it.
 */
type ReindexCursor =
  | Readonly<{ type: "memo" | "document"; id: string }>
  | Readonly<{ done: true }>;

const START: ReindexCursor = { type: "memo", id: "" };

function parseCursor(raw: string | null): ReindexCursor {
  if (raw === null) return START;
  const parsed = JSON.parse(raw) as ReindexCursor;
  return parsed;
}

export type ReindexDeps = Readonly<{
  runUnitOfWork: UnitOfWorkRunner<UserDataUnitOfWorkContext>;
}>;

/**
 * `reindex`: the FTS5 projection re-run over every active row, one row at
 * a time as "delete with the old values, insert with the new"
 * (`spec/database/index.md`, `'rebuild'` は使わない). Seeded by the
 * migration gate when a step changes the tokenizer or the normalisation,
 * never enqueued from a usecase.
 *
 * Each chunk is one transaction that re-projects `jobsMaxRowsPerChunk`
 * rows and moves the cursor through `setMigrationCursor` — the one write
 * path into `migration_progress` — so a DO reset mid-job loses at most
 * the chunk in flight. `jobsMaxChunkIterations` chunks per wake-up, then
 * `yield`; `finished` once the walk reaches `done`, the cursor row left
 * as the record.
 */
export function createReindexHandler(deps: ReindexDeps): JobHandler {
  return async ({ storage, payload, now, tuning }) => {
    const { targetVersion } = payload as ReindexPayload;
    if (!Number.isInteger(targetVersion)) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "reindex: the payload names no target version",
      );
    }
    const sql = storage.sql;
    for (let i = 0; i < tuning.jobsMaxChunkIterations; i += 1) {
      const cursor = parseCursor(
        readMigrationCursor(sql, targetVersion, REINDEX_STEP),
      );
      if ("done" in cursor) return { kind: "finished" };
      const done = await deps.runUnitOfWork((ctx) => {
        const next = reprojectChunk(sql, cursor, tuning.jobsMaxRowsPerChunk);
        ctx.setMigrationCursor({
          targetVersion,
          step: REINDEX_STEP,
          cursor: JSON.stringify(next),
        });
        return "done" in next;
      });
      if (done) return { kind: "finished" };
    }
    return { kind: "yield", nextRunAt: new Date(now) };
  };
}

function reprojectChunk(
  sql: SqlStorage,
  cursor: Exclude<ReindexCursor, { done: true }>,
  limit: number,
): ReindexCursor {
  if (cursor.type === "memo") {
    const ids = sql
      .exec<{ id: string }>(
        "SELECT id FROM memos WHERE status = 'active' AND id > ? ORDER BY id LIMIT ?",
        cursor.id,
        limit,
      )
      .toArray()
      .map((row) => row.id);
    for (const id of ids) reprojectMemo(sql, id);
    const last = ids[ids.length - 1];
    return ids.length < limit || last === undefined
      ? { type: "document", id: "" }
      : { type: "memo", id: last };
  }
  const rows = sql
    .exec<{
      id: string;
      topic_id: string;
      title: string;
      body: string;
      updated_at: number;
    }>(
      "SELECT id, topic_id, title, body, updated_at FROM documents WHERE status = 'active' AND id > ? ORDER BY id LIMIT ?",
      cursor.id,
      limit,
    )
    .toArray();
  for (const row of rows) {
    projectDocument(sql, {
      id: row.id,
      topicId: row.topic_id,
      title: row.title,
      body: row.body,
      updatedAt: new Date(row.updated_at),
    });
  }
  const last = rows[rows.length - 1];
  return rows.length < limit || last === undefined
    ? { done: true }
    : { type: "document", id: last.id };
}
