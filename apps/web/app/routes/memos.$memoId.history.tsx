import { createFileRoute, redirect } from "@tanstack/react-router";
import { Suspense } from "react";
import { FogShell } from "@/components/fog/FogShell";
import { TimelineSkeleton } from "@/components/fog/TimelineSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { loadFogSession } from "@/presentation/fogActions";
import { renderFogMemoHistory } from "@/presentation/fogMemoActions";
import { safeReturnTo } from "@/presentation/fogSecurity";

export const Route = createFileRoute("/memos/$memoId/history")({
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
  loader: ({ params }) => renderFogMemoHistory({ data: { id: params.memoId } }),
  head: () => ({ meta: [{ title: "メモの履歴 — fog" }] }),
  component: Page,
  errorComponent: ({ error }) => (
    <main className="fog-auth">
      <section className="fog-auth-sheet" role="alert">
        <h1>履歴を読み込めませんでした</h1>
        <p>{sanitizeRouteError(error)}</p>
        <a href="/timeline">タイムラインに戻る</a>
      </section>
    </main>
  ),
});
function Page() {
  const { actor } = Route.useRouteContext();
  const { content } = Route.useLoaderData();
  return (
    <FogShell actor={actor} title="メモの履歴">
      <Suspense fallback={<TimelineSkeleton />}>
        <Deferred promise={content} />
      </Suspense>
    </FogShell>
  );
}
