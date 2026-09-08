import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { CurrentUserPanel } from "../CurrentUserPanel";

const loadCurrentUser = serverData(
  () => import("@repo/core/application/identity/getCurrentUser"),
  async ({ container }, { getCurrentUser }, userId: string) => ({
    user: await getCurrentUser({ container, input: { userId } }),
    ssoProviders: container.config.ssoProviders,
  }),
);

/** The streamed leaf of `/settings`. */
export async function SettingsFeed() {
  const { user, ssoProviders } = await guardStreamedRender(async () => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    return loadCurrentUser(userId);
  });
  return <CurrentUserPanel user={user} ssoProviders={ssoProviders} />;
}
