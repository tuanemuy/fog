import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { z } from "zod";
import { ssoErrorSchema } from "@/components/auth/schema";
import { SettingsSkeleton } from "@/components/settings/SettingsSkeleton";
import { SsoNotice } from "@/components/settings/SsoNotice";
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

const searchSchema = z.object({
  sso: z.enum(["linked"]).optional(),
  sso_error: ssoErrorSchema.optional(),
});

export const Route = createFileRoute("/_app/settings")({
  validateSearch: searchSchema,
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
  const { sso, sso_error: ssoError } = Route.useSearch();
  return (
    <>
      {(sso !== undefined || ssoError !== undefined) && (
        <div className="fog-content">
          <SsoNotice sso={sso} ssoError={ssoError} />
        </div>
      )}
      <Suspense fallback={<SettingsSkeleton />}>
        <Deferred promise={Settings} />
      </Suspense>
    </>
  );
}
