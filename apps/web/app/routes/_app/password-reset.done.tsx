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

const renderDone = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .handler(async () => {
    const { PasswordResetDoneFeed } = await import(
      "@/components/settings/PasswordResetDoneFeed"
    );
    return { Done: renderServerComponent(<PasswordResetDoneFeed />) };
  });

/** P-03 after the reset: authenticated by the session the reset just started. */
export const Route = createFileRoute("/_app/password-reset/done")({
  staleTime: 0,
  ...streamingRouteOptions,
  loader: async () => {
    const { Done } = await renderDone();
    return { Done };
  },
  head: ({ match }) =>
    routeHead(match, {
      title: "パスワードを再設定しました — fog",
      path: "/password-reset/done",
    }),
  component: PasswordResetDonePage,
  errorComponent: ({ error }) => (
    <div className="fog-content" role="alert">
      <h2>読み込めませんでした</h2>
      <p>{sanitizeRouteError(error)}</p>
    </div>
  ),
});

function PasswordResetDonePage() {
  const { Done } = Route.useLoaderData();
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <Deferred promise={Done} />
    </Suspense>
  );
}
