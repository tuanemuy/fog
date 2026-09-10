import { HardDeletePolicy } from "@repo/core/domain/trash/service";
import { ValidationError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { Logger } from "../ports/logger";
import { executeHardDeletePlan } from "./hardDeleteSteps";
import type { RunUnitOfWork } from "./shared";

export type PruneBudget = Readonly<{
  /** Rows one chunk may touch. */
  chunkLimit: number;
  /** Chunk iterations one wake-up may run, recalculation and deletion together. */
  maxChunks: number;
}>;

export type PruneResult = Readonly<{
  processedCount: number;
  failedCount: number;
  /** Work is left for the next wake-up: recalculation, or a full last chunk. */
  hasMore: boolean;
  /** The earliest deadline still in the trash after this pass; `null` when it is empty. */
  nextPurgeAfter: Date | null;
}>;

/** Both bounds together, or "chunkLimit rows, forever" would pass as bounded. */
export function checkPruneBudget(budget: PruneBudget): PruneBudget {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new ValidationError(
        "INVALID_PRUNE_BUDGET",
        `${name} must be an integer of at least 1`,
      );
    }
  }
  return budget;
}

/**
 * S-TR-05, the body of the `purge-trash` job. Never exposed to a caller.
 *
 * Phase 1 finishes a pending `purge_after` recalculation (a retention
 * change the changing transaction could not complete) one chunk per
 * transaction; while any is left the deletion phase does not run — an
 * extension must have reached every row before anything is judged
 * expired. Phase 2 erases what the stored deadlines say is expired, one
 * transaction per item, deferring an item that fails. Both phases share
 * the wake-up's chunk budget and stop on it (`spec/usecases/trash.md`).
 */
export function pruneExpiredTrashItems(
  run: RunUnitOfWork<UserDataUnitOfWorkContext>,
  deps: { now: Date; budget: PruneBudget; logger: Logger },
): PruneResult {
  const { chunkLimit, maxChunks } = checkPruneBudget(deps.budget);
  let chunksLeft = maxChunks;

  const retentionDays = run(
    (ctx) =>
      ctx.userSettingsRepository.find()?.entity.trashRetentionDays ?? null,
  );
  if (retentionDays !== null) {
    let pending = true;
    while (pending && chunksLeft > 0) {
      const step = run((ctx) => {
        const memos = ctx.memoRepository.recalculatePurgeAfter(
          retentionDays,
          chunkLimit,
        );
        const topics = ctx.topicRepository.recalculatePurgeAfter(
          retentionDays,
          chunkLimit,
        );
        const documents = ctx.documentRepository.recalculatePurgeAfter(
          retentionDays,
          chunkLimit,
        );
        return {
          updated:
            memos.updatedCount + topics.updatedCount + documents.updatedCount,
          hasMore: memos.hasMore || topics.hasMore || documents.hasMore,
        };
      });
      pending = step.hasMore;
      // A probe that touched nothing is not a chunk of work.
      if (step.updated > 0 || step.hasMore) chunksLeft -= 1;
    } // Still recalculating, or recalculated on the last chunk: the deletion
    // phase has not looked at the trash yet, so the next wake-up must.
    if (pending || chunksLeft === 0) {
      return {
        processedCount: 0,
        failedCount: 0,
        hasMore: true,
        nextPurgeAfter: run((ctx) =>
          ctx.trashQueryPort.findEarliestPurgeAfter(),
        ),
      };
    }
  }

  let processedCount = 0;
  let failedCount = 0;
  let lastChunkFull = false;
  while (chunksLeft > 0) {
    chunksLeft -= 1;
    const items = run((ctx) =>
      ctx.trashQueryPort.listItemsToPurge(deps.now, chunkLimit),
    );
    if (items.length === 0) {
      lastChunkFull = false;
      break;
    }
    for (const item of items) {
      try {
        run((ctx) =>
          executeHardDeletePlan(ctx, HardDeletePolicy.expandTargets(item)),
        );
        processedCount += 1;
      } catch (error) {
        failedCount += 1;
        deps.logger.warn("purge-trash: an item was deferred", {
          kind: item.kind,
          cause: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    lastChunkFull = items.length === chunkLimit;
    if (!lastChunkFull) break;
  }
  return {
    processedCount,
    failedCount,
    hasMore: lastChunkFull && chunksLeft === 0,
    nextPurgeAfter: run((ctx) => ctx.trashQueryPort.findEarliestPurgeAfter()),
  };
}
