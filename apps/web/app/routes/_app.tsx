import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { readAuthStateFn } from "@/presentation/authState";
import { toSafeRedirect } from "@/presentation/redirectSearch";

/**
 * The protected layout. `beforeLoad` is the navigation aid that bounces an
 * unauthenticated visitor to `/login` with the current URL to return to; the
 * guard proper is `requireUserId()` in every server execution point below.
 * Because every protected document passes through `readAuthStateFn`, its
 * `noStoreMiddleware` stamps `Cache-Control: no-store` on all of them.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const { authenticated } = await readAuthStateFn();
    if (!authenticated) {
      const target = toSafeRedirect(location.href);
      throw redirect({
        to: "/login",
        search:
          target === undefined || target === "/" ? {} : { redirect: target },
      });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
