import type { HumanActor } from "@repo/core/application/fog/types";
import type { FogSearch } from "@/presentation/fogDataSchema";
import { serverData } from "@/presentation/serverAction";
import { SearchBoard } from "./SearchBoard";

const load = serverData(
  () => import("@repo/core/application/fog/runtime"),
  async (
    _context,
    { getFogServices },
    actor: HumanActor,
    search: FogSearch,
  ) => ({
    page: search.query
      ? await getFogServices().search(actor, {
          query: search.query,
          ...(search.topicId ? { topicId: search.topicId } : {}),
          limit: 30,
        })
      : { items: [], nextCursor: null },
    topics: await getFogServices().listTopics(actor),
  }),
);
export async function SearchContent({
  actor,
  search,
}: {
  actor: HumanActor;
  search: FogSearch;
}) {
  const { page, topics } = await load(actor, search);
  return (
    <SearchBoard
      key={JSON.stringify(search)}
      page={page}
      topics={topics}
      search={search}
    />
  );
}
