import type { HumanActor } from "@repo/core/application/fog/types";
import { getFogAccountRuntime } from "@/presentation/fogAccountRuntime";
import { serverData } from "@/presentation/serverAction";
import { SettingsPanel } from "./SettingsPanel";

const load = serverData(
  () => import("@repo/core/application/fog/runtime"),
  async (_context, { getFogServices }, actor: HumanActor) =>
    Promise.all([
      getFogServices().getSettings(actor),
      getFogServices().listAiConnections(actor),
      getFogServices().credentials(actor),
    ]),
);
export async function SettingsContent({ actor }: { actor: HumanActor }) {
  const [settings, connections, credentials] = await load(actor);
  return (
    <SettingsPanel
      settings={settings}
      connections={connections}
      credentials={credentials}
      googleEnabled={getFogAccountRuntime().googleEnabled}
    />
  );
}
