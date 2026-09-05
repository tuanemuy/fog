import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Suspense } from "react";
import { FogShell } from "@/components/fog/FogShell";
import { TimelineSkeleton } from "@/components/fog/TimelineSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { loadFogSession } from "@/presentation/fogActions";
import { renderFogAiConsent } from "@/presentation/fogAiActions";
import { aiConsentSearchSchema } from "@/presentation/fogAiSchema";
import { safeReturnTo } from "@/presentation/fogSecurity";

export const Route = createFileRoute("/ai/authorize")({
  staleTime: 0,
  validateSearch: (search) => aiConsentSearchSchema.parse(search),
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
  loader: ({ deps }) => renderFogAiConsent({ data: deps }),
  head: () => ({
    meta: [
      { title: "AIクライアントの認可 — fog" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: Page,
  errorComponent: ({ error }) => (
    <main className="fog-auth">
      <section className="fog-auth-sheet" role="alert">
        <h1>この認可要求は利用できません</h1>
        <p>{sanitizeRouteError(error)}</p>
        <p>LLMアプリから接続をやり直してください。</p>
        <Link to="/settings">設定へ</Link>
      </section>
    </main>
  ),
});
function Page() {
  const { actor } = Route.useRouteContext();
  const { content } = Route.useLoaderData();
  return (
    <FogShell actor={actor} title="AIクライアントの認可">
      <Suspense fallback={<TimelineSkeleton />}>
        <Deferred promise={content} />
      </Suspense>
    </FogShell>
  );
}
