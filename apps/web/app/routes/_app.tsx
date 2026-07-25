import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppShell } from "@/components/layout/AppShell";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { toSafeRedirect } from "@/presentation/redirectSearch";

const readAuthStateFn = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .handler(async () => {
    const { getCurrentUserId } = await import("@/presentation/currentUser");
    return { authenticated: (await getCurrentUserId()) !== null };
  });

export const Route = createFileRoute("/_app")({
  // Router-cache entries for protected screens must not survive a logout,
  // or the back button would restore one from memory (manual TC-23).
  staleTime: 0,
  // A pre-emptive redirect for navigation comfort, not the security
  // boundary: on client-side transitions this runs in the browser. Every
  // server execution point that reads protected data calls
  // `requireUserId()` itself (ADR-005).
  beforeLoad: async ({ location }) => {
    const { authenticated } = await readAuthStateFn();
    if (authenticated) return;
    const from = toSafeRedirect(location.href);
    throw redirect({
      to: "/login",
      search: from === undefined ? {} : { redirect: from },
    });
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
