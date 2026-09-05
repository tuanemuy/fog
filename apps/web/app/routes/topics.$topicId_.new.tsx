import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense } from "react";
import { FogShell } from "@/components/fog/FogShell";
import { TimelineSkeleton } from "@/components/fog/TimelineSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { loadFogSession } from "@/presentation/fogActions";
import { renderFogDocument } from "@/presentation/fogDocumentActions";
import { safeReturnTo } from "@/presentation/fogSecurity";

export const Route = createFileRoute("/topics/$topicId_/new")({
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
    renderFogDocument({ data: { id: params.topicId, mode: "new" } }),
  head: () => ({ meta: [{ title: "新しいドキュメント — fog" }] }),
  component: Page,
});
function Page() {
  const { actor } = Route.useRouteContext();
  const { topicId } = Route.useParams();
  const { content } = Route.useLoaderData();
  return (
    <FogShell
      actor={actor}
      title="新しいドキュメント"
      backHref={`/topics/${encodeURIComponent(topicId)}`}
    >
      <Suspense fallback={<TimelineSkeleton />}>
        <Deferred promise={content} />
      </Suspense>
    </FogShell>
  );
}
