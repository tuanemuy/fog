import type {
  UnitOfWorkProvider,
  UserDataUnitOfWorkContext,
} from "@repo/core/application/execution/unitOfWork";
import type { Logger } from "@repo/core/application/ports/logger";
import { pruneExpiredTrashItems } from "@repo/core/application/trash/pruneExpiredTrashItems";
import type { JobHandler } from "../jobRunner";

export type PurgeTrashDeps = Readonly<{
  /** A fresh provider per wake-up; every `run` is one transaction. */
  provider: () => UnitOfWorkProvider<UserDataUnitOfWorkContext>;
  logger: Logger;
}>;

/**
 * `purge-trash`: recalculation left over from a retention change, then the
 * expired rows, under the wake-up's chunk budget. Ends `finished` on an
 * empty trash (a soft delete or a retention change revives the row),
 * re-arms on the earliest remaining deadline, and yields at once when the
 * budget ran out — or when an item was deferred, so a conflict is retried
 * on the next pass rather than at the next deadline.
 */
export function createPurgeTrashHandler(deps: PurgeTrashDeps): JobHandler {
  return async ({ now, tuning }) => {
    const provider = deps.provider();
    const result = pruneExpiredTrashItems((fn) => provider.run(fn), {
      now: new Date(now),
      budget: {
        chunkLimit: tuning.jobsMaxRowsPerChunk,
        maxChunks: tuning.jobsMaxChunkIterations,
      },
      logger: deps.logger,
    });
    if (result.hasMore) return { kind: "yield", nextRunAt: new Date(now) };
    if (result.nextPurgeAfter === null) return { kind: "finished" };
    const next = result.nextPurgeAfter.getTime();
    // A deferred item keeps a past deadline: come back next pass, not now.
    const nextRunAt =
      result.failedCount > 0
        ? Math.max(next, now + tuning.jobsBackoffBaseMs)
        : Math.max(next, now + 1);
    return { kind: "rearm", nextRunAt: new Date(nextRunAt) };
  };
}
