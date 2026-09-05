import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense } from "react";
import { FogShell } from "@/components/fog/FogShell";
import { TimelineSkeleton } from "@/components/fog/TimelineSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { loadFogSession } from "@/presentation/fogActions";
import { renderFogDocument } from "@/presentation/fogDocumentActions";
import { safeReturnTo } from "@/presentation/fogSecurity";

export const Route = createFileRoute("/documents/$documentId")({
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
  loader: ({ params }) =>
    renderFogDocument({ data: { id: params.documentId, mode: "view" } }),
  head: () => ({ meta: [{ title: "ドキュメント — fog" }] }),
  component: Page,
});
function Page() {
  const { actor } = Route.useRouteContext();
  const { content } = Route.useLoaderData();
  return (
    <FogShell actor={actor} title="ドキュメント" backHref="/topics">
      <Suspense fallback={<TimelineSkeleton />}>
        <Deferred promise={content} />
      </Suspense>
    </FogShell>
  );
}
