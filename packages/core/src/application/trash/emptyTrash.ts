import { HardDeletePolicy } from "@repo/core/domain/trash/service";
import type { TrashItemRef } from "@repo/core/domain/trash/valueObject";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { Logger } from "../ports/logger";
import type { ServiceArgs } from "../types";
import { executeHardDeletePlan } from "./hardDeleteSteps";
import { TRASH_MAX_LIMIT } from "./listTrash";
import type { RunUnitOfWork } from "./shared";
import type { EmptyTrashView } from "./view";

export type EmptyTrashInput = Readonly<{ userId: string }>;

/** S-TR-04, request side. The 「n 件」 confirmation is the screen's. */
export async function emptyTrash({
  container,
  input,
}: ServiceArgs<EmptyTrashInput>): Promise<EmptyTrashView> {
  return container.trashGateway.emptyTrash(input.userId);
}

/** `expandTargets` over a whole page, deduplicated per kind: a set's documents appear twice otherwise. */
export function collectTargets(
  items: readonly Parameters<typeof HardDeletePolicy.expandTargets>[0][],
): TrashItemRef[] {
  const documents = new Set<string>();
  const memos = new Set<string>();
  const topics = new Set<string>();
  for (const item of items) {
    const plan = HardDeletePolicy.expandTargets(item);
    for (const id of plan.documentIds) documents.add(id);
    for (const id of plan.memoIds) memos.add(id);
    for (const id of plan.topicIds) topics.add(id);
  }
  return [
    ...[...documents].map((id) => ({ kind: "document", id }) as TrashItemRef),
    ...[...memos].map((id) => ({ kind: "memo", id }) as TrashItemRef),
    ...[...topics].map((id) => ({ kind: "topic", id }) as TrashItemRef),
  ];
}

/**
 * Inside the DO, one transaction per target so a failure rolls back that
 * target alone. Erased rows leave the listing, so page 1 is read again
 * until it is empty; a page on which nothing could be erased ends the
 * loop instead of spinning on it.
 */
export function emptyTrashInDurableObject(
  run: RunUnitOfWork<UserDataUnitOfWorkContext>,
  logger: Logger,
): EmptyTrashView {
  let deletedCount = 0;
  let failedCount = 0;
  // A deferred target stays listed; it is counted once and not retried here.
  const deferred = new Set<string>();
  for (;;) {
    const items = run(
      (ctx) =>
        ctx.trashQueryPort.listTrashItems({ page: 1, limit: TRASH_MAX_LIMIT })
          .items,
    );
    if (items.length === 0) break;
    let erasedThisPage = 0;
    for (const target of collectTargets(items)) {
      const key = `${target.kind}:${target.id}`;
      if (deferred.has(key)) continue;
      try {
        const erased = run((ctx) =>
          executeHardDeletePlan(ctx, {
            memoIds: target.kind === "memo" ? [target.id] : [],
            documentIds: target.kind === "document" ? [target.id] : [],
            topicIds: target.kind === "topic" ? [target.id] : [],
          }),
        );
        erasedThisPage += erased;
        deletedCount += erased;
      } catch (error) {
        deferred.add(key);
        failedCount += 1;
        logger.warn("emptyTrash: an item was deferred", {
          kind: target.kind,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (erasedThisPage === 0) break;
  }
  return { deletedCount, failedCount };
}
