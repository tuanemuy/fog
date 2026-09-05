import type { HumanActor } from "@repo/core/application/fog/types";
import { serverData } from "@/presentation/serverAction";
import { TrashBoard } from "./TrashBoard";

const load = serverData(
  () => import("@repo/core/application/fog/runtime"),
  async (_context, { getFogServices }, actor: HumanActor) => ({
    trash: await getFogServices().trash(actor),
    topics: await getFogServices().listTopics(actor),
  }),
);
export async function TrashContent({ actor }: { actor: HumanActor }) {
  const { trash, topics } = await load(actor);
  return <TrashBoard data={trash} topics={topics} />;
}
