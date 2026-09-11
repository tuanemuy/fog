import { ButtonLink } from "@/components/ui/ButtonLink";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { AiConnectionsList } from "../AiConnectionsList";
import { AiConnectionsPanel } from "../AiConnectionsPanel";
import { CredentialList } from "../CredentialList";
import { DONE_ACTIONS_CLASS, DONE_SECTION_CLASS } from "./styles";

const loadCurrentUser = serverData(
  () => import("@repo/core/application/identity/getCurrentUser"),
  async ({ container }, { getCurrentUser }, userId: string) => ({
    user: await getCurrentUser({ container, input: { userId } }),
    mcpUrl: new URL("/mcp", container.config.appUrl).toString(),
  }),
);

const loadAiConnections = serverData(
  () => import("@repo/core/application/identity/listAiClientConnections"),
  async ({ container }, { listAiClientConnections }, userId: string) =>
    (await listAiClientConnections({ container, input: { userId } }))
      .connections,
);

/**
 * The streamed leaf of `/password-reset/done` (P-03 after the reset,
 * `spec/design/pages/password-reset.html` 完了): the login methods with their
 * unlink, the AI connections with their revocation, and the way on to the
 * timeline. The title and the description above it are the route's, drawn
 * before this streams in. The link-adding entry is deliberately absent —
 * this screen removes what the user does not recognise; it never adds.
 */
export async function PasswordResetDoneFeed() {
  const { user, mcpUrl, aiConnections } = await guardStreamedRender(
    async () => {
      const { requireUserId } = await import("@/presentation/currentUser");
      const userId = await requireUserId();
      const [loaded, aiConnections] = await Promise.all([
        loadCurrentUser(userId),
        loadAiConnections(userId),
      ]);
      return { ...loaded, aiConnections };
    },
  );
  return (
    <>
      <section
        aria-labelledby="reset-done-credentials"
        className={DONE_SECTION_CLASS}
      >
        <SectionLabel id="reset-done-credentials">ログイン手段</SectionLabel>
        <CredentialList credentials={user.credentials} linkProviders={[]} />
      </section>
      <section aria-labelledby="reset-done-ai" className={DONE_SECTION_CLASS}>
        <SectionLabel id="reset-done-ai">AI</SectionLabel>
        <AiConnectionsList connections={aiConnections} mcpUrl={mcpUrl} />
        <AiConnectionsPanel />
      </section>
      <div className={DONE_ACTIONS_CLASS}>
        <ButtonLink variant="fill" to="/">
          タイムラインへ進む
        </ButtonLink>
      </div>
    </>
  );
}
