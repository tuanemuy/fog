import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense } from "react";
import { FogShell } from "@/components/fog/FogShell";
import { TimelineSkeleton } from "@/components/fog/TimelineSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { loadFogSession, renderFogTimeline } from "@/presentation/fogActions";
import { safeReturnTo } from "@/presentation/fogSecurity";
import { timelineSearchSchema } from "@/presentation/fogTimelineSchema";

export const Route = createFileRoute("/timeline")({
  staleTime: 0,
  validateSearch: (search) => timelineSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  beforeLoad: async ({ location }) => {
    const actor = await loadFogSession({ data: {} });
    if (!actor)
      throw redirect({
        to: "/login",
        search: { returnTo: safeReturnTo(location.href) },
      });
    return { actor };
  },
  loader: ({ deps }) => renderFogTimeline({ data: deps }),
  head: () => ({ meta: [{ title: "タイムライン — fog" }] }),
  component: Page,
  errorComponent: ({ error }) => (
    <main className="fog-auth">
      <section className="fog-auth-sheet" role="alert">
        <h1>読み込めませんでした</h1>
        <p>{sanitizeRouteError(error)}</p>
        <a href="/timeline">もう一度読み込む</a>
      </section>
    </main>
  ),
});

function Page() {
  const { actor } = Route.useRouteContext();
  const { content } = Route.useLoaderData();
  return (
    <FogShell actor={actor}>
      <Suspense fallback={<TimelineSkeleton />}>
        <Deferred promise={content} />
      </Suspense>
    </FogShell>
  );
}
