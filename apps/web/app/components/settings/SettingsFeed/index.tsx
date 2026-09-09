import { isNotFound, isRedirect } from "@tanstack/react-router";
import { displayError } from "@/presentation/errorDisplay";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { CurrentUserPanel } from "../CurrentUserPanel";
import { SettingsUnavailable } from "../SettingsUnavailable";

const loadCurrentUser = serverData(
  () => import("@repo/core/application/identity/getCurrentUser"),
  async ({ container }, { getCurrentUser }, userId: string) => ({
    user: await getCurrentUser({ container, input: { userId } }),
    ssoProviders: container.config.ssoProviders,
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
 * The streamed leaf of `/settings`. The guard's redirect (no session) is
 * the only failure that leaves this component; a failure to read the
 * account degrades to {@link SettingsUnavailable}, which still lets the
 * user sign out. The guard has already logged and redacted it.
 */
export async function SettingsFeed() {
  const userId = await guardStreamedRender(async () => {
    const { requireUserId } = await import("@/presentation/currentUser");
    return requireUserId();
  });
  try {
    const { user, ssoProviders, mcpUrl, aiConnections } =
      await guardStreamedRender(async () => {
        const [loaded, aiConnections] = await Promise.all([
          loadCurrentUser(userId),
          loadAiConnections(userId),
        ]);
        return { ...loaded, aiConnections };
      });
    return (
      <CurrentUserPanel
        user={user}
        ssoProviders={ssoProviders}
        aiConnections={aiConnections}
        mcpUrl={mcpUrl}
      />
    );
  } catch (error) {
    if (isRedirect(error) || isNotFound(error)) throw error;
    return <SettingsUnavailable message={displayError(error)} />;
  }
}
