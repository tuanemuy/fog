import type { HumanActor } from "@repo/core/application/fog/types";
import type { TimelineSearch } from "@/presentation/fogTimelineSchema";
import { serverData } from "@/presentation/serverAction";
import { TimelineBoard } from "./TimelineBoard";

const loadMemos = serverData(
  () => import("@repo/core/application/fog/runtime"),
  async (
    _context,
    { getFogServices },
    actor: HumanActor,
    search: TimelineSearch,
  ) => (await getFogServices()).listTimeline(actor, { ...search, limit: 30 }),
);

export async function TimelineContent({
  actor,
  search,
}: {
  actor: HumanActor;
  search: TimelineSearch;
}) {
  return (
    <TimelineBoard
      key={JSON.stringify(search)}
      search={search}
      page={await loadMemos(actor, search)}
    />
  );
}
