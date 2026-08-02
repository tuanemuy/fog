/**
 * Forward-only schema steps. There is no downward migration: the array is the
 * source of truth on the code side (`spec/database/index.md` is the source of
 * truth overall), and a DO whose `_meta.schema_version` is higher than
 * `codeVersion` is fail-closed rather than downgraded.
 */
export type MigrationStep = Readonly<{
  /** `_meta.schema_version` after this step has been applied. */
  version: number;
  /** DDL. Every statement is written so that re-running it is harmless. */
  statements: readonly string[];
  /**
   * Bulk work this step defers to a job, enqueued in the same transaction that
   * advances `schema_version`. `jobs` has exactly one write path
   * (`enqueueJob`), so the gate goes through it rather than issuing its own
   * INSERT.
   */
  enqueue?: readonly { kind: "reindex" | "migrate-bulk"; step: number }[];
}>;

export function codeVersionOf(steps: readonly MigrationStep[]): number {
  return steps.reduce((max, step) => Math.max(max, step.version), 0);
}
