import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { type ReactNode, Suspense } from "react";
import { navTitle } from "@/components/layout/AppShell/navItems";
import { LogoutButton } from "@/components/settings/LogoutButton";
import { SettingsSkeleton } from "@/components/settings/SettingsSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { ERROR_TITLE, ErrorRetry } from "@/components/ui/ErrorRetry";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";

const renderSettings = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .handler(async () => {
    const { CurrentUserPanel } = await import(
      "@/components/settings/CurrentUserPanel"
    );
    // Returned UNRESOLVED so the loader can forward it without awaiting;
    // awaiting here collapses back to a blocking render — no skeleton.
    return { Panel: renderServerComponent(<CurrentUserPanel />) };
  });

export const Route = createFileRoute("/_app/settings")({
  loader: async () => {
    const { Panel } = await renderSettings();
    return { Panel };
  },
  head: ({ match }) =>
    routeHead(match, { title: navTitle("/settings"), path: "/settings" }),
  component: SettingsPage,
  // This route needs a boundary of its own. Without one the throw travels to
  // `_app`'s `errorComponent`, which stands in for the whole screen — sign-out
  // included. A revoked session is exactly that case: the Durable Object is
  // the authority on revocation, so `CurrentUserPanel` throws while the cookie
  // and the shell survive, and this is the only screen that can drop it.
  errorComponent: SettingsErrorScreen,
});

/**
 * Everything on `/settings` that must survive the panel failing.
 *
 * `logout` reaches no Durable Object, so signing out still works when the
 * panel cannot load — which is what keeps a revoked session from stranding
 * the user on a screen with no way out.
 */
function SettingsScreen({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <div className="border-t border-neutral-100 pt-lg">
        <LogoutButton />
      </div>
    </>
  );
}

function SettingsPage() {
  const { Panel } = Route.useLoaderData();
  return (
    <SettingsScreen>
      <Suspense fallback={<SettingsSkeleton />}>
        <Deferred promise={Panel} />
      </Suspense>
    </SettingsScreen>
  );
}

function SettingsErrorScreen({ error }: { error: unknown }) {
  const message = sanitizeRouteError(error);
  return (
    <SettingsScreen>
      <section className="flex flex-col gap-lg pb-2xl">
        <h2 className="text-xl font-bold leading-tight">{ERROR_TITLE}</h2>
        {message === ERROR_TITLE ? null : (
          <p className="text-base text-neutral-600 text-balance">{message}</p>
        )}
        <ErrorRetry />
      </section>
    </SettingsScreen>
  );
}
