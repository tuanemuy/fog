import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense } from "react";
import { AccountNotice } from "@/components/fog/AccountNotice";
import { FogShell } from "@/components/fog/FogShell";
import { TimelineSkeleton } from "@/components/fog/TimelineSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { loadFogSession } from "@/presentation/fogActions";
import { renderFogSettings } from "@/presentation/fogDataActions";
import { safeReturnTo } from "@/presentation/fogSecurity";

export const Route = createFileRoute("/settings")({
  staleTime: 0,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.auth === "string" ? { auth: search.auth } : {}),
  }),
  beforeLoad: async ({ location }) => {
    const actor = await loadFogSession({ data: {} });
    if (!actor)
      throw redirect({
        to: "/login",
        search: { returnTo: safeReturnTo(location.href) },
      });
    return { actor };
  },
  loader: () => renderFogSettings({ data: {} }),
  head: () => ({ meta: [{ title: "設定 — fog" }] }),
  component: Page,
});
function Page() {
  const { auth } = Route.useSearch();
  const { actor } = Route.useRouteContext();
  const { content } = Route.useLoaderData();
  return (
    <FogShell actor={actor} title="設定">
      <AccountNotice status={auth} />
      <Suspense fallback={<TimelineSkeleton />}>
        <Deferred promise={content} />
      </Suspense>
    </FogShell>
  );
}
