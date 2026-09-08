import { DocumentId, TopicId } from "@repo/core/domain/knowledge/valueObject";
import { MemoId } from "@repo/core/domain/memo/valueObject";
import type { TrashItemRef } from "@repo/core/domain/trash/valueObject";
import { NotFoundError } from "../errors";
import type { TrashItemRefDto } from "./gateway";

export function trashItemNotFound(): NotFoundError {
  return new NotFoundError(
    "TRASH_ITEM_NOT_FOUND",
    "The item is not in the trash",
  );
}

/** The second validation point: the id value object rebuilt inside the DO. */
export function rebuildRef(dto: TrashItemRefDto): TrashItemRef {
  switch (dto.kind) {
    case "memo":
      return { kind: "memo", id: MemoId.create(dto.id) };
    case "document":
      return { kind: "document", id: DocumentId.create(dto.id) };
    case "topic":
      return { kind: "topic", id: TopicId.create(dto.id) };
  }
}

/** One transaction per call; the trash usecases that walk many items call it repeatedly, never nested. */
export type RunUnitOfWork<TCtx> = <T>(
  fn: (ctx: TCtx) => T extends Promise<unknown> ? never : T,
) => T;
