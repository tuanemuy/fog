import type { HumanActor } from "@repo/core/application/fog/types";
import { serverData } from "@/presentation/serverAction";
import { TopicDetail } from "./TopicDetail";

const load = serverData(
  () => import("@repo/core/application/fog/runtime"),
  async (_context, { getFogServices }, actor: HumanActor, id: string) =>
    getFogServices().getTopic(actor, id),
);
export async function TopicContent({
  actor,
  id,
}: {
  actor: HumanActor;
  id: string;
}) {
  return <TopicDetail detail={await load(actor, id)} />;
}
