import type { Sql } from "../sql/exec";

/**
 * The data-rewriting half of a migration.
 *
 * A `MigrationStep` applies DDL in one transaction, which is only viable while
 * the statement count is bounded. Back-filling a new column is not bounded by
 * anything but the user's data, so it is deferred to a `migrate-bulk` job and
 * described here instead.
 *
 * `runChunk` returns the cursor to resume from, or `null` once the step has no
 * rows left. **It must be idempotent**: job execution is at-least-once, and a
 * DO can reset between the chunk committing and its cursor being recorded.
 */
export type BulkMigrationStep = Readonly<{
  /** The `_meta.schema_version` this back-fill belongs to. */
  targetVersion: number;
  /** Discriminates several back-fills within one version. */
  step: number;
  runChunk(sql: Sql, cursor: string, limit: number): string | null;
}>;

/**
 * Empty by design: version 1 creates the schema and has nothing to back-fill.
 * The first migration that rewrites data adds its entry here in the same commit
 * that adds the `enqueue` to `USER_DATA_STEPS`.
 */
export const USER_DATA_BULK_STEPS: readonly BulkMigrationStep[] = [];

export function findBulkStep(
  steps: readonly BulkMigrationStep[],
  targetVersion: number,
  step: number,
): BulkMigrationStep | null {
  return (
    steps.find(
      (candidate) =>
        candidate.targetVersion === targetVersion && candidate.step === step,
    ) ?? null
  );
}
