import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { TopicsSkeleton } from "@/components/topics/TopicsSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { streamingRouteOptions } from "@/presentation/streamingRoute";

const renderTopics = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .handler(async () => {
    const { TopicsFeed } = await import("@/components/topics/TopicsFeed");
    return { Topics: renderServerComponent(<TopicsFeed />) };
  });

/** P-06. */
export const Route = createFileRoute("/_app/topics")({
  staticData: { header: { kind: "top", title: "トピック" } },
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  loader: async () => {
    const { Topics } = await renderTopics();
    return { Topics };
  },
  head: ({ match }) =>
    routeHead(match, { title: "トピック — fog", path: "/topics" }),
  component: TopicsPage,
  errorComponent: ({ error }) => (
    <div role="alert">
      <h2>読み込めませんでした</h2>
      <p>{sanitizeRouteError(error)}</p>
    </div>
  ),
});

function TopicsPage() {
  const { Topics } = Route.useLoaderData();
  return (
    <div className="pb-sheet-end">
      <Suspense fallback={<TopicsSkeleton />}>
        <Deferred promise={Topics} />
      </Suspense>
    </div>
  );
}
