import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { TopicList } from "../TopicList";

const loadTopics = serverData(
  () => import("@repo/core/application/knowledge/listTopics"),
  async ({ container }, { listTopics }, userId: string) =>
    listTopics({ container, input: { userId, includeArchived: true } }),
);

/**
 * The streamed leaf of `/topics`: every live topic, archived ones included
 * so the island can fold them into 「完了済み」.
 */
export async function TopicsFeed() {
  const initial = await guardStreamedRender(async () => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    return loadTopics(userId);
  });
  return <TopicList initial={initial} />;
}
