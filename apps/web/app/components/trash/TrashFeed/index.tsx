import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { TRASH_PAGE_LIMIT } from "../schema";
import { TrashBoard } from "../TrashBoard";

const loadTrash = serverData(
  () => import("@repo/core/application/trash/listTrash"),
  async ({ container }, { listTrash }, userId: string) =>
    listTrash({
      container,
      input: { userId, page: 1, limit: TRASH_PAGE_LIMIT },
    }),
);

/** The streamed leaf of `/trash`: the first page, newest deletion first. */
export async function TrashFeed() {
  const initial = await guardStreamedRender(async () => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    return loadTrash(userId);
  });
  return <TrashBoard initial={initial} />;
}
