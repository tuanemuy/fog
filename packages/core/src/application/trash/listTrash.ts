import { ValidationError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { ListTrashDto } from "./gateway";
import { type TrashListView, toTrashItemView } from "./view";

export const TRASH_MAX_LIMIT = 100;

export type ListTrashInput = Readonly<{
  userId: string;
  page: number;
  limit: number;
}>;

/** Shape checks the transport may have skipped; the DO repeats none of them. */
export function checkTrashPagination(input: ListTrashDto): ListTrashDto {
  if (!Number.isInteger(input.page) || input.page < 1) {
    throw new ValidationError(
      "INVALID_PAGE",
      "page must be an integer of at least 1",
    );
  }
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > TRASH_MAX_LIMIT
  ) {
    throw new ValidationError(
      "INVALID_LIMIT",
      `limit must be an integer between 1 and ${TRASH_MAX_LIMIT}`,
    );
  }
  return { page: input.page, limit: input.limit };
}

/** S-TR-01, request side. No existence check: an uninitialised object is an empty trash. */
export async function listTrash({
  container,
  input,
}: ServiceArgs<ListTrashInput>): Promise<TrashListView> {
  return container.trashGateway.listTrash(
    input.userId,
    checkTrashPagination({ page: input.page, limit: input.limit }),
  );
}

export function listTrashProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: ListTrashDto,
): TrashListView {
  const page = ctx.trashQueryPort.listTrashItems(input);
  return {
    items: page.items.map(toTrashItemView),
    totalCount: page.count,
    page: input.page,
    limit: input.limit,
  };
}
