import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { CurrentUserPanel } from "../CurrentUserPanel";

const loadCurrentUser = serverData(
  () => import("@repo/core/application/identity/getCurrentUser"),
  async ({ container }, { getCurrentUser }, userId: string) =>
    getCurrentUser({ container, input: { userId } }),
);

/** The streamed leaf of `/settings`. */
export async function SettingsFeed() {
  const user = await guardStreamedRender(async () => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    return loadCurrentUser(userId);
  });
  return <CurrentUserPanel user={user} />;
}
