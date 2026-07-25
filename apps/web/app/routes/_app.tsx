import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { ERROR_TITLE, ErrorRetry } from "@/components/ui/ErrorRetry";
import { readAuthStateFn } from "@/presentation/authState";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { toSafeRedirect } from "@/presentation/redirectSearch";

export const Route = createFileRoute("/_app")({
  // Router-cache entries for protected screens must not survive a logout,
  // or the back button would restore one from memory (manual TC-23).
  staleTime: 0,
  // A pre-emptive redirect for navigation comfort, not the security
  // boundary: on client-side transitions this runs in the browser. Every
  // server execution point that reads protected data calls
  // `requireUserId()` itself (.issue/1/adr.md ADR-005).
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
  errorComponent: ({ error }) => (
    <ShellErrorScreen message={sanitizeRouteError(error)} />
  ),
});

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/**
 * The failure surface for every protected screen (.issue/1/adr.md ADR-048).
 *
 * Wired here rather than per leaf so streaming routes get it by default: an
 * exception from a deferred RSC fragment surfaces during the leaf's render,
 * and without a catch boundary between it and the root the whole signed-in
 * shell is replaced by the signed-out sheet.
 *
 * A route's `errorComponent` stands in for that route's own component, so
 * the shell has to be rendered again here — `AppShell` derives everything it
 * shows from the pathname, so it comes back identical.
 */
function ShellErrorScreen({ message }: { message: string }) {
  return (
    <AppShell>
      <section className="flex flex-col gap-lg py-2xl">
        <h2 className="text-xl font-bold leading-tight">{ERROR_TITLE}</h2>
        {message === ERROR_TITLE ? null : (
          <p className="text-base text-neutral-600 text-balance">{message}</p>
        )}
        <ErrorRetry />
      </section>
    </AppShell>
  );
}
