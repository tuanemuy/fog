import { extractSerializedError } from "@/presentation/errorResponse";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { SearchPanel, type SearchPanelInitial } from "../SearchPanel";
import { SEARCH_PAGE_LIMIT } from "../schema";
import type { SearchPageSearch } from "../search";

const loadTopics = serverData(
  () => import("@repo/core/application/knowledge/listTopics"),
  async ({ container }, { listTopics }, userId: string) =>
    listTopics({ container, input: { userId, includeArchived: true } }),
);

const loadFirstPage = serverData(
  () => import("@repo/core/application/search/search"),
  async (
    { container },
    { search },
    userId: string,
    keyword: string,
    topicId: string | null,
  ) =>
    search({
      container,
      input: {
        userId,
        keyword,
        topicId,
        cursor: null,
        limit: SEARCH_PAGE_LIMIT,
      },
    }),
);

/**
 * The streamed leaf of `/search`: the topic chips (a snapshot taken when
 * the screen opens — archived ones included) and, when there is a keyword,
 * the first page. A scope whose topic is gone becomes the 「見つからない」
 * state rather than an empty list (`spec/pages/index.md` P-11).
 */
export async function SearchFeed({ search }: { search: SearchPageSearch }) {
  const { topics, initial } = await guardStreamedRender(async () => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const [list, initial] = await Promise.all([
      loadTopics(userId),
      firstPage(userId, search),
    ]);
    return { topics: list.topics, initial };
  });
  return (
    <SearchPanel
      topics={topics.map((topic) => ({
        id: topic.id,
        name: topic.name,
        archived: topic.status === "archived",
      }))}
      search={search}
      initial={initial}
    />
  );
}

async function firstPage(
  userId: string,
  search: SearchPageSearch,
): Promise<SearchPanelInitial> {
  if (search.q === undefined) return { kind: "idle" };
  try {
    const page = await loadFirstPage(userId, search.q, search.topic ?? null);
    return { kind: "results", page };
  } catch (error) {
    const serialized = extractSerializedError(error);
    if (
      serialized.kind === "notFound" &&
      serialized.code === "TOPIC_NOT_FOUND"
    ) {
      return { kind: "topicMissing" };
    }
    throw error;
  }
}
