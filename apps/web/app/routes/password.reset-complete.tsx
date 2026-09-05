import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense } from "react";
import { FogShell } from "@/components/fog/FogShell";
import { TimelineSkeleton } from "@/components/fog/TimelineSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { renderFogResetComplete } from "@/presentation/fogAccountViews";
import { loadFogSession } from "@/presentation/fogActions";
import { safeReturnTo } from "@/presentation/fogSecurity";

export const Route = createFileRoute("/password/reset-complete")({
  staleTime: 0,
  beforeLoad: async ({ location }) => {
    const actor = await loadFogSession({ data: {} });
    if (!actor)
      throw redirect({
        to: "/login",
        search: { returnTo: safeReturnTo(location.href) },
      });
    return { actor };
  },
  loader: () => renderFogResetComplete({ data: {} }),
  head: () => ({ meta: [{ title: "再設定完了 — fog" }] }),
  component: Page,
});
function Page() {
  const { actor } = Route.useRouteContext();
  const { content } = Route.useLoaderData();
  return (
    <FogShell actor={actor} title="再設定完了">
      <Suspense fallback={<TimelineSkeleton />}>
        <Deferred promise={content} />
      </Suspense>
    </FogShell>
  );
}
