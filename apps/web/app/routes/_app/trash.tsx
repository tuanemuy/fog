import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { TrashSkeleton } from "@/components/trash/TrashSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { streamingRouteOptions } from "@/presentation/streamingRoute";

const renderTrash = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .handler(async () => {
    const { TrashFeed } = await import("@/components/trash/TrashFeed");
    return { Trash: renderServerComponent(<TrashFeed />) };
  });

/** P-12. */
export const Route = createFileRoute("/_app/trash")({
  staticData: { header: { kind: "top", title: "ゴミ箱" } },
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  loader: async () => {
    const { Trash } = await renderTrash();
    return { Trash };
  },
  head: ({ match }) =>
    routeHead(match, { title: "ゴミ箱 — fog", path: "/trash" }),
  component: TrashPage,
  errorComponent: ({ error }) => (
    <div role="alert">
      <h2>読み込めませんでした</h2>
      <p>{sanitizeRouteError(error)}</p>
    </div>
  ),
});

function TrashPage() {
  const { Trash } = Route.useLoaderData();
  return (
    <div className="pb-sheet-end">
      <Suspense fallback={<TrashSkeleton />}>
        <Deferred promise={Trash} />
      </Suspense>
    </div>
  );
}
