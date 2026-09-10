import type { SetMigrationCursorInput } from "@repo/core/application/execution/unitOfWork";

/**
 * `migration_progress` — the partial-application cursor of `reindex` and
 * `migrate-bulk` (`spec/database/index.md`). One write, an upsert on
 * `(target_version, step)`; the two kinds share the table and never the
 * same `step`.
 */
export function writeMigrationCursor(
  sql: SqlStorage,
  input: SetMigrationCursorInput,
  now: number,
): void {
  sql.exec(
    `INSERT INTO migration_progress (target_version, step, cursor, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (target_version, step) DO UPDATE SET
       cursor = excluded.cursor, updated_at = excluded.updated_at`,
    input.targetVersion,
    input.step,
    input.cursor,
    now,
  );
}

export function readMigrationCursor(
  sql: SqlStorage,
  targetVersion: number,
  step: string,
): string | null {
  return (
    sql
      .exec<{ cursor: string }>(
        "SELECT cursor FROM migration_progress WHERE target_version = ? AND step = ?",
        targetVersion,
        step,
      )
      .toArray()[0]?.cursor ?? null
  );
}
