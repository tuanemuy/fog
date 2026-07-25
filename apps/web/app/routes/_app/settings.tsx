import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { navTitle } from "@/components/layout/AppShell/navItems";
import { SettingsSkeleton } from "@/components/settings/SettingsSkeleton";
import { Deferred } from "@/components/ui/Deferred";
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
});

function SettingsPage() {
  const { Panel } = Route.useLoaderData();
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <Deferred promise={Panel} />
    </Suspense>
  );
}
