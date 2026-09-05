import type { HumanActor } from "@repo/core/application/fog/types";
import { serverData } from "@/presentation/serverAction";
import { TopicsBoard } from "./TopicsBoard";

const load = serverData(
  () => import("@repo/core/application/fog/runtime"),
  async (_context, { getFogServices }, actor: HumanActor) =>
    getFogServices().listTopics(actor),
);
export async function TopicsContent({ actor }: { actor: HumanActor }) {
  return <TopicsBoard topics={await load(actor)} />;
}
