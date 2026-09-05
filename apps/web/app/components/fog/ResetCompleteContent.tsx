import type { HumanActor } from "@repo/core/application/fog/types";
import { getFogAccountRuntime } from "@/presentation/fogAccountRuntime";
import { serverData } from "@/presentation/serverAction";
import { AiConnectionsPanel } from "./AiConnectionsPanel";
import { CredentialsPanel } from "./CredentialsPanel";

const load = serverData(
  () => import("@repo/core/application/fog/runtime"),
  async (_context, { getFogServices }, actor: HumanActor) =>
    Promise.all([
      getFogServices().credentials(actor),
      getFogServices().listAiConnections(actor),
    ]),
);
export async function ResetCompleteContent({ actor }: { actor: HumanActor }) {
  const [credentials, connections] = await load(actor);
  return (
    <section className="fog-content">
      <h2>パスワードを再設定しました</h2>
      <p>
        以前のログインはすべて終了し、この端末でログインしました。前回の再設定以降に追加されたAI接続も失効しました。身に覚えのないログイン手段や残っているAI接続がないか確認してください。
      </p>
      <CredentialsPanel
        credentials={credentials}
        googleEnabled={getFogAccountRuntime().googleEnabled}
      />
      <AiConnectionsPanel connections={connections} />
      <a className="fog-primary" href="/timeline">
        タイムラインへ
      </a>
    </section>
  );
}
