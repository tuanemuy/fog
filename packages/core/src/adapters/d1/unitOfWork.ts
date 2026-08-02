import type {
  UnitOfWorkContext,
  UnitOfWorkProvider,
} from "@repo/core/application/execution/unitOfWork";
import type { Clock } from "@repo/core/application/ports/clock";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type { Database } from "./client";
import { PendingBatch } from "./pendingBatch";
import { isOccGuardViolation, mapDbError } from "./repositories/helpers";
import { D1UserRepository } from "./repositories/userRepository";

/**
 * D1 implementation of `UnitOfWorkProvider`.
 *
 * D1 has no interactive transactions, so a `db.transaction(fn)` shape
 * is impossible. The replacement is a deferred-batch model:
 *
 *   1. The caller's `fn` runs through to completion. Reads execute
 *      immediately against `db`; writes accumulate on a `PendingBatch`.
 *
 *   2. After `fn` returns, a single `db.batch()` flushes everything
 *      atomically. If the batch fails because an OCC-guarded write
 *      matched zero rows (`_occ_guard` CHECK violation), the buffer's
 *      head conflict handler throws a domain-friendly
 *      `ConflictError("OPTIMISTIC_LOCK_FAILURE")`. Other driver errors
 *      are translated through `mapDbError`.
 *
 * Read-your-write within the same UoW is unsupported by design: DDD
 * usecases mutate the loaded aggregate in memory and persist once, so a
 * usecase that needs the post-write row back must let this UoW commit
 * and read from a fresh one.
 *
 * No application-level retry: D1 surfaces transient conditions
 * (`SQLITE_BUSY` / `SQLITE_LOCKED`) as connection-level errors that
 * the binding handles upstream of this adapter, and OCC mismatches
 * are caller-visible signals rather than retry candidates.
 */
export class D1UnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(
    private readonly db: Database,
    // Kept in the signature so the call sites do not move. Nothing this
    // provider writes carries a timestamp of its own any more.
    _clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    const pending = new PendingBatch(this.db);

    const userRepository = new D1UserRepository(
      this.db,
      pending,
      this.idGenerator,
    );

    const ctx: UnitOfWorkContext = { userRepository };

    const result = await fn(ctx);

    if (pending.isEmpty()) {
      // Nothing to flush — pure-read UoW. D1 rejects empty batches, so
      // exit before calling `db.batch()`.
      return result;
    }

    await mapDbError("Failed to commit unit of work", async () => {
      try {
        await this.db.batch(pending.build());
      } catch (error) {
        if (isOccGuardViolation(error)) {
          const handler = pending.firstConflictHandler();
          // Defensive: a guard violation without a registered handler
          // would mean the batch carried an `_occ_guard` statement
          // without an `addOcc` registration — i.e. the buffer was
          // built incorrectly. Throw the original error so the bug is
          // not swallowed.
          if (handler) handler();
        }
        throw error;
      }
    });

    return result;
  }
}
