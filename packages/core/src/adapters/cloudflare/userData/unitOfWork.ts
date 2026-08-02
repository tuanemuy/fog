import type { DurableObjectState } from "@cloudflare/workers-types";
import type {
  EnqueueJobArgs,
  LocatorRef,
  OperationKind,
  OperationPatch,
  OperationPhase,
  OperationRecord,
  RecordOperationArgs,
} from "@repo/core/application/execution/jobs";
import type {
  UnitOfWorkProvider,
  UserDataUnitOfWorkContext,
} from "@repo/core/application/execution/unitOfWork";
import type { Clock } from "@repo/core/application/ports/clock";
import { enqueueJob } from "../jobs/table";
import { one, run, type Sql } from "../sql/exec";
import { createAccountStore } from "./accountStore";
import { createCredentialLocatorStore } from "./credentialLocatorStore";
import { createUserSettingsRepository } from "./userSettingsRepository";

/**
 * The User Data DO's unit of work.
 *
 * `run` is nothing more than `ctx.storage.transactionSync(() => fn(context))`:
 * the DO is single-threaded and its input gate excludes concurrent handlers, so
 * the transaction *is* the isolation. There is no retry here — an OCC conflict
 * travels out to the transport boundary unswallowed.
 *
 * The context deliberately offers no route back to this provider, which is how
 * "never call `run` from inside `run`" is held: `transactionSync` has no
 * documented nesting behaviour and `sql.exec()` cannot issue `SAVEPOINT`.
 */
export function createUserDataUnitOfWorkProvider(
  ctx: DurableObjectState,
  clock: Clock,
): UnitOfWorkProvider<UserDataUnitOfWorkContext> {
  const sql = ctx.storage.sql as Sql;
  const now = () => clock.now().getTime();
  const context = createUserDataContext(sql, now);

  return {
    run<T>(
      fn: (
        c: UserDataUnitOfWorkContext,
      ) => T extends Promise<unknown> ? never : T,
    ): T {
      return ctx.storage.transactionSync(() => fn(context)) as T;
    },
  };
}

/**
 * Exported for the DO-side job handlers, which run *outside* a transaction and
 * open their own, and for integration tests that exercise one store directly.
 */
export function createUserDataContext(
  sql: Sql,
  now: () => number,
): UserDataUnitOfWorkContext {
  return {
    userSettingsRepository: createUserSettingsRepository(sql, now),
    accountStore: createAccountStore(sql, now),
    credentialLocatorStore: createCredentialLocatorStore(sql, now),

    enqueueJob(args: EnqueueJobArgs): void {
      enqueueJob(sql, now(), args);
    },

    findOperation(operationId: string): OperationRecord | null {
      const row = one<{
        operation_id: string;
        kind: string;
        payload_digest: string;
        phase: string;
        target_locators: string | null;
        terminal_reason: string | null;
      }>(
        sql,
        `SELECT operation_id, kind, payload_digest, phase, target_locators, terminal_reason
           FROM operations WHERE operation_id = ?`,
        operationId,
      );
      if (row === null) return null;
      return {
        operationId: row.operation_id,
        kind: row.kind as OperationKind,
        payloadDigest: row.payload_digest,
        phase: row.phase as OperationPhase,
        targetLocators:
          row.target_locators === null
            ? []
            : (JSON.parse(row.target_locators) as readonly LocatorRef[]),
        terminalReason: row.terminal_reason,
      };
    },

    recordOperation(args: RecordOperationArgs): void {
      run(
        sql,
        `INSERT INTO operations (
           operation_id, kind, payload_digest, phase, target_locators,
           terminal_reason, created_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        args.operationId,
        args.kind,
        args.payloadDigest,
        args.phase,
        args.targetLocators === undefined
          ? null
          : JSON.stringify(args.targetLocators),
        now(),
      );
    },

    updateOperation(operationId: string, patch: OperationPatch): void {
      // Built as a partial update so that "advance the phase" cannot silently
      // erase the stashed locators — those are the only reverse information an
      // orphan-mapping recovery has, and clearing them is never intended here.
      const assignments: string[] = [];
      const bindings: unknown[] = [];
      if (patch.phase !== undefined) {
        assignments.push("phase = ?");
        bindings.push(patch.phase);
      }
      if (patch.targetLocators !== undefined) {
        assignments.push("target_locators = ?");
        bindings.push(JSON.stringify(patch.targetLocators));
      }
      if (patch.terminalReason !== undefined) {
        assignments.push("terminal_reason = ?");
        bindings.push(patch.terminalReason);
      }
      if (assignments.length === 0) return;
      run(
        sql,
        `UPDATE operations SET ${assignments.join(", ")} WHERE operation_id = ?`,
        ...bindings,
        operationId,
      );
    },

    setMigrationCursor(
      targetVersion: number,
      step: string,
      cursor: string,
    ): void {
      run(
        sql,
        `INSERT INTO migration_progress (target_version, step, cursor, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (target_version, step) DO UPDATE SET
           cursor = excluded.cursor,
           updated_at = excluded.updated_at`,
        targetVersion,
        step,
        cursor,
        now(),
      );
    },
  };
}
