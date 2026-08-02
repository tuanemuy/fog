import { CHUNK_BUDGETS } from "@repo/core/lib/jobBudgets";
import {
  type BulkMigrationStep,
  findBulkStep,
  USER_DATA_BULK_STEPS,
} from "../../schema/bulkSteps";
import { all, type Sql } from "../../sql/exec";
import { createUserDataContext } from "../../userData/unitOfWork";
import type { JobHandler, UserDataJobContext } from "../registry";
import type { JobRow } from "../table";

/**
 * Runs the data-rewriting half of a migration in bounded chunks.
 *
 * The step itself is described by a {@link BulkMigrationStep}; this handler
 * only supplies the chunking, the cursor and the atomicity, which is what makes
 * "a migration is interruptible" a property of every back-fill rather than of
 * whichever one remembered to implement it.
 *
 * A request arriving mid-migration is served, not rejected: the DDL step
 * already committed, so the schema is the new one, and readers have to tolerate
 * rows the back-fill has not reached yet. That tolerance is the step author's
 * obligation, and it is why the DDL and the back-fill are separate steps at all.
 */

function stepName(step: number): string {
  return `migrate-bulk:${step}`;
}

type BulkPayload = { targetVersion: number; step: number };

function readPayload(row: JobRow): BulkPayload | null {
  const payload = JSON.parse(row.payload) as {
    targetVersion?: unknown;
    step?: unknown;
  } | null;
  if (
    typeof payload?.targetVersion !== "number" ||
    typeof payload.step !== "number"
  ) {
    return null;
  }
  return { targetVersion: payload.targetVersion, step: payload.step };
}

function readStoredCursor(
  sql: Sql,
  targetVersion: number,
  step: number,
): string {
  const rows = all<{ cursor: string }>(
    sql,
    "SELECT cursor FROM migration_progress WHERE target_version = ? AND step = ?",
    targetVersion,
    stepName(step),
  );
  return rows[0]?.cursor ?? "";
}

/**
 * Parameterised on the step table so that a suite can drive a synthetic
 * version-2 step without registering it in the production array — which would
 * make every real Durable Object try to apply it.
 */
export function createMigrateBulkHandler(
  steps: readonly BulkMigrationStep[],
): JobHandler<UserDataJobContext> {
  return async (context, row) => {
    const { ctx, sql, now, logger } = context;
    const budget = CHUNK_BUDGETS["migrate-bulk"];
    const payload = readPayload(row);
    if (payload === null) {
      return {
        kind: "terminal",
        reason: "MIGRATE_BULK_PAYLOAD_INVALID",
      };
    }

    const step = findBulkStep(steps, payload.targetVersion, payload.step);
    if (step === null) {
      // A deployment that no longer carries the step cannot finish it, and
      // pretending otherwise would leave half-migrated rows looking migrated.
      return { kind: "terminal", reason: "MIGRATE_BULK_STEP_UNKNOWN" };
    }

    const uow = createUserDataContext(sql, () => now);
    let cursor = readStoredCursor(sql, payload.targetVersion, payload.step);

    for (let chunk = 0; chunk < budget.maxChunks; chunk += 1) {
      const next = ctx.storage.transactionSync(() => {
        const advanced = step.runChunk(sql, cursor, budget.chunkRowLimit);
        if (advanced !== null) {
          uow.setMigrationCursor(
            payload.targetVersion,
            stepName(payload.step),
            advanced,
          );
        }
        return advanced;
      });
      if (next === null) {
        logger.info("migrate-bulk finished", {
          targetVersion: payload.targetVersion,
          step: payload.step,
        });
        return { kind: "done" };
      }
      cursor = next;
    }
    return { kind: "yield" };
  };
}

export const migrateBulk = createMigrateBulkHandler(USER_DATA_BULK_STEPS);
