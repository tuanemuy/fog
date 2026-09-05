import { getFogServices } from "@repo/core/application/fog/runtime";
import type { HumanActor } from "@repo/core/application/fog/types";
import { MemoHistoryClient } from "./MemoHistoryClient";

export async function MemoHistoryContent({
  actor,
  id,
}: {
  actor: HumanActor;
  id: string;
}) {
  const services = getFogServices();
  const [memo, revisions] = await Promise.all([
    services.getMemo(actor, id),
    services.memoHistory(actor, id),
  ]);
  return (
    <MemoHistoryClient
      id={id}
      revisions={revisions}
      currentVersion={memo.version}
    />
  );
}
