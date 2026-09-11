import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { MemoHistorySkeleton } from "@/components/memoHistory/MemoHistorySkeleton";
import { memoHistoryParamsSchema } from "@/components/memoHistory/schema";
import { Deferred } from "@/components/ui/Deferred";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { streamingRouteOptions } from "@/presentation/streamingRoute";
import { validateInput } from "@/presentation/validator";

const renderMemoHistory = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(memoHistoryParamsSchema))
  .handler(async ({ data }) => {
    const { MemoHistoryFeed } = await import(
      "@/components/memoHistory/MemoHistoryFeed"
    );
    return {
      History: renderServerComponent(<MemoHistoryFeed memoId={data.memoId} />),
    };
  });

/** P-05. `memos_` keeps it out of any `/memos` layout the tree may grow. */
export const Route = createFileRoute("/_app/memos_/$memoId/history")({
  staticData: {
    header: { kind: "back", entity: "memo", back: "/", h1: "header" },
  },
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  loader: async ({ params }) => {
    const { History } = await renderMemoHistory({
      data: { memoId: params.memoId },
    });
    return { History };
  },
  head: ({ match, params }) =>
    routeHead(match, {
      title: "メモ履歴 — fog",
      path: `/memos/${params.memoId}/history`,
    }),
  component: MemoHistoryPage,
  errorComponent: ({ error }) => (
    <div className="fog-content" role="alert">
      <h2>読み込めませんでした</h2>
      <p>{sanitizeRouteError(error)}</p>
    </div>
  ),
});

function MemoHistoryPage() {
  const { History } = Route.useLoaderData();
  return (
    <div className="fog-content">
      <Suspense fallback={<MemoHistorySkeleton />}>
        <Deferred promise={History} />
      </Suspense>
    </div>
  );
}
