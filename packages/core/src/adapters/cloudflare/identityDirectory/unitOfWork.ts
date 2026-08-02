import type { DurableObjectState } from "@cloudflare/workers-types";
import type { EnqueueJobArgs } from "@repo/core/application/execution/jobs";
import type {
  IdentityDirectoryUnitOfWorkContext,
  UnitOfWorkProvider,
} from "@repo/core/application/execution/unitOfWork";
import type { Clock } from "@repo/core/application/ports/clock";
import { enqueueJob } from "../jobs/table";
import type { Sql } from "../sql/exec";
import { createCredentialMappingRepository } from "./credentialMappingRepository";
import { createCredentialMappingStore } from "./mappingOperations";
import { createResetTokenStore } from "./resetTokenStore";
import { createRotationCheckpointStore } from "./rotationCheckpointStore";

/**
 * The Identity Directory DO's unit of work.
 *
 * The context carries five things — `credentialMappingRepository` (reads),
 * `credentialMappingStore` (the seven CAS writes), `resetTokenStore`,
 * `rotationCheckpointStore` and `enqueueJob` — **and that is the complete set
 * of write paths into this DO class's transaction**. `sql` is deliberately not
 * among them, which is what lets the roster be counted against
 * `spec/database/index.md` rather than merely asserted.
 *
 * `operations` and `migration_progress` live in the User Data DO, so this class
 * has no `recordOperation` / `updateOperation` / `setMigrationCursor`.
 */
export function createIdentityDirectoryUnitOfWorkProvider(
  ctx: DurableObjectState,
  clock: Clock,
  tokenKeyGeneration: number,
): UnitOfWorkProvider<IdentityDirectoryUnitOfWorkContext> {
  const sql = ctx.storage.sql as Sql;
  const now = () => clock.now().getTime();
  const context = createIdentityDirectoryContext(sql, now, tokenKeyGeneration);

  return {
    run<T>(
      fn: (
        c: IdentityDirectoryUnitOfWorkContext,
      ) => T extends Promise<unknown> ? never : T,
    ): T {
      return ctx.storage.transactionSync(() => fn(context)) as T;
    },
  };
}

/** Exported for job handlers, which open their own transaction. */
export function createIdentityDirectoryContext(
  sql: Sql,
  now: () => number,
  tokenKeyGeneration: number,
): IdentityDirectoryUnitOfWorkContext {
  return {
    credentialMappingRepository: createCredentialMappingRepository(sql),
    credentialMappingStore: createCredentialMappingStore(sql, now),
    resetTokenStore: createResetTokenStore(sql, tokenKeyGeneration),
    rotationCheckpointStore: createRotationCheckpointStore(sql),
    enqueueJob(args: EnqueueJobArgs): void {
      enqueueJob(sql, now(), args);
    },
  };
}
