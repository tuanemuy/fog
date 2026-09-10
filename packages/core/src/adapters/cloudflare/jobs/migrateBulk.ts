import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  UnitOfWorkRunner,
  UserDataUnitOfWorkContext,
} from "@repo/core/application/execution/unitOfWork";
import type { JobHandler } from "../jobRunner";
import type { MigrationPlan } from "../schema/plan";
import { readMigrationCursor } from "../stores/migrationProgressStore";

/** `jobs.operation_key` of the `migrate-bulk` a migration to `targetVersion` seeds: one row per version. */
export const migrateBulkOperationKey = (targetVersion: number) =>
  `migrate-bulk:${targetVersion}`;

export type MigrateBulkPayload = Readonly<{ targetVersion: number }>;

/** `migration_progress.step` of one bulk step. */
export const migrateBulkStep = (version: number, name: string) =>
  `migrate-bulk:${version}:${name}`;

type StoredCursor = Readonly<{ at: string | null }> | Readonly<{ done: true }>;

export type MigrateBulkDeps = Readonly<{
  plan: () => MigrationPlan;
  runUnitOfWork: UnitOfWorkRunner<UserDataUnitOfWorkContext>;
}>;

/**
 * `migrate-bulk`: the data-rewriting halves (`MigrationStep.bulk`) of
 * every step up to the payload's target version, walked in version order
 * under one `migration_progress` cursor per step (`spec/database/index.md`).
 * Seeded by the migration gate after the DDL committed; never enqueued
 * from a usecase.
 *
 * A chunk is one transaction: the step's `run` for `jobsMaxRowsPerChunk`
 * rows and the cursor write through `setMigrationCursor`. A step whose
 * `run` answered `null` is recorded `done` and skipped afterwards, so a
 * re-run from a reset resumes at the step and position it last committed.
 * `jobsMaxChunkIterations` chunks per wake-up, then `yield`.
 */
export function createMigrateBulkHandler(deps: MigrateBulkDeps): JobHandler {
  return async ({ storage, payload, now, tuning }) => {
    const { targetVersion } = payload as MigrateBulkPayload;
    if (!Number.isInteger(targetVersion)) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "migrate-bulk: the payload names no target version",
      );
    }
    const sql = storage.sql;
    const steps = deps
      .plan()
      .steps.filter((step) => step.version <= targetVersion && step.bulk)
      .sort((a, b) => a.version - b.version);
    let budget = tuning.jobsMaxChunkIterations;
    for (const step of steps) {
      const bulk = step.bulk;
      if (bulk === undefined) continue;
      const stepName = migrateBulkStep(step.version, bulk.name);
      for (;;) {
        const stored = readMigrationCursor(sql, targetVersion, stepName);
        const cursor: StoredCursor =
          stored === null ? { at: null } : (JSON.parse(stored) as StoredCursor);
        if ("done" in cursor) break;
        if (budget === 0) return { kind: "yield", nextRunAt: new Date(now) };
        budget -= 1;
        await deps.runUnitOfWork((ctx) => {
          const { nextCursor } = bulk.run(
            sql,
            cursor.at,
            tuning.jobsMaxRowsPerChunk,
          );
          const next: StoredCursor =
            nextCursor === null ? { done: true } : { at: nextCursor };
          ctx.setMigrationCursor({
            targetVersion,
            step: stepName,
            cursor: JSON.stringify(next),
          });
          return undefined;
        });
      }
    }
    return { kind: "finished" };
  };
}
