import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense } from "react";
import { FogShell } from "@/components/fog/FogShell";
import { TimelineSkeleton } from "@/components/fog/TimelineSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { loadFogSession } from "@/presentation/fogActions";
import { renderFogSearch } from "@/presentation/fogDataActions";
import { searchSchema } from "@/presentation/fogDataSchema";
import { safeReturnTo } from "@/presentation/fogSecurity";

export const Route = createFileRoute("/search")({
  staleTime: 0,
  validateSearch: (search) => searchSchema.parse(search),
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
  loader: ({ deps }) => renderFogSearch({ data: deps }),
  head: () => ({ meta: [{ title: "検索 — fog" }] }),
  component: Page,
});
function Page() {
  const { actor } = Route.useRouteContext();
  const { content } = Route.useLoaderData();
  return (
    <FogShell actor={actor} title="検索">
      <Suspense fallback={<TimelineSkeleton />}>
        <Deferred promise={content} />
      </Suspense>
    </FogShell>
  );
}
