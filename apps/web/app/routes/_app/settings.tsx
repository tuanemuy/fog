import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { navTitle } from "@/components/layout/AppShell/navItems";
import { CurrentUserPanel } from "@/components/settings/CurrentUserPanel";
import { SettingsSkeleton } from "@/components/settings/SettingsSkeleton";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";

const loadSettings = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .handler(async () => {
    const [{ requireUserId }, { loadServerDeps }] = await Promise.all([
      import("@/presentation/currentUser"),
      import("@/presentation/serverAction"),
    ]);
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@/presentation/identityActionHandlers"),
    );
    const user = await module.currentUserAction(container, userId);
    return {
      user: {
        email: user.email,
        authMethods: user.authMethods,
      },
    };
  });

export const Route = createFileRoute("/_app/settings")({
  loader: async () => {
    const { user } = await loadSettings();
    return { user };
  },
  head: ({ match }) =>
    routeHead(match, { title: navTitle("/settings"), path: "/settings" }),
  pendingComponent: SettingsSkeleton,
  component: SettingsPage,
});

function SettingsPage() {
  const { user } = Route.useLoaderData();
  return <CurrentUserPanel user={user} />;
}
