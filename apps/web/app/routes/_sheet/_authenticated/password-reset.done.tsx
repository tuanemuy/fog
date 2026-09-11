import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { AuthSheetTitle } from "@/components/layout/AuthSheet";
import { SettingsSkeleton } from "@/components/settings/SettingsSkeleton";
import { Deferred } from "@/components/ui/Deferred";
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

/**
 * P-03 after the reset, on the auth sheet: authenticated by the session the
 * reset just started.
 */
export const Route = createFileRoute(
  "/_sheet/_authenticated/password-reset/done",
)({
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
});

function PasswordResetDonePage() {
  const { Done } = Route.useLoaderData();
  return (
    <>
      <AuthSheetTitle>パスワードを再設定しました</AuthSheetTitle>
      <div className="mt-section">
        <Suspense fallback={<SettingsSkeleton />}>
          <Deferred promise={Done} />
        </Suspense>
      </div>
    </>
  );
}
