import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { SettingsSkeleton } from "@/components/settings/SettingsSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { streamingRouteOptions } from "@/presentation/streamingRoute";

const renderSettings = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .handler(async () => {
    const { SettingsFeed } = await import("@/components/settings/SettingsFeed");
    return { Settings: renderServerComponent(<SettingsFeed />) };
  });

export const Route = createFileRoute("/_app/settings")({
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  loader: async () => {
    const { Settings } = await renderSettings();
    return { Settings };
  },
  head: ({ match }) =>
    routeHead(match, { title: "設定 — fog", path: "/settings" }),
  component: SettingsPage,
  errorComponent: ({ error }) => (
    <div className="fog-content" role="alert">
      <h2>読み込めませんでした</h2>
      <p>{sanitizeRouteError(error)}</p>
    </div>
  ),
});

function SettingsPage() {
  const { Settings } = Route.useLoaderData();
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <Deferred promise={Settings} />
    </Suspense>
  );
}
