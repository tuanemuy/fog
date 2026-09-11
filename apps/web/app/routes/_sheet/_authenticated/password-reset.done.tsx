import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { AuthSheetDescription } from "@/components/auth/AuthSheetDescription";
import { AuthSheetTitle } from "@/components/layout/AuthSheet";
import { PasswordResetDoneSkeleton } from "@/components/settings/PasswordResetDoneFeed/skeleton";
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
      title: "パスワードを更新しました — fog",
      path: "/password-reset/done",
    }),
  component: PasswordResetDonePage,
});

function PasswordResetDonePage() {
  const { Done } = Route.useLoaderData();
  return (
    <>
      <AuthSheetTitle>パスワードを更新しました</AuthSheetTitle>
      <AuthSheetDescription>
        覚えの無いログイン手段や接続は、ここで解除できます
      </AuthSheetDescription>
      <Suspense fallback={<PasswordResetDoneSkeleton />}>
        <Deferred promise={Done} />
      </Suspense>
    </>
  );
}
