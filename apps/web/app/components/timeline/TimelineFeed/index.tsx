import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { TIMELINE_PAGE_LIMIT } from "../schema";
import { TimelineBoard } from "../TimelineBoard";

const loadTimeline = serverData(
  () => import("@repo/core/application/memo/getTimeline"),
  async ({ container }, { getTimeline }, userId: string) =>
    getTimeline({
      container,
      input: { userId, limit: TIMELINE_PAGE_LIMIT },
    }),
);

/**
 * The streamed leaf of `/`: reads the first page inside the RSC render and
 * hands the list to the client island that owns it from then on.
 */
export async function TimelineFeed() {
  const page = await guardStreamedRender(async () => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    return loadTimeline(userId);
  });
  return <TimelineBoard initial={page} />;
}
