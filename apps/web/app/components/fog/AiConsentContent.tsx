import type { HumanActor } from "@repo/core/application/fog/types";
import { serverData } from "@/presentation/serverAction";
import { AiConsentPanel } from "./AiConsentPanel";

const load = serverData(
  () => import("@repo/core/application/fog/runtime"),
  async (
    _context,
    { getFogServices },
    actor: HumanActor,
    requestToken: string,
  ) => getFogServices().getAiAuthorization(actor, requestToken),
);
export async function AiConsentContent({
  actor,
  requestToken,
}: {
  actor: HumanActor;
  requestToken: string;
}) {
  return (
    <AiConsentPanel
      authorization={await load(actor, requestToken)}
      requestToken={requestToken}
    />
  );
}
