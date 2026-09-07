import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { TimelineSkeleton } from "@/components/timeline/TimelineSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { streamingRouteOptions } from "@/presentation/streamingRoute";

// Returns the UNRESOLVED promise so navigation settles at once and the list
// streams in under the skeleton.
const renderTimeline = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .handler(async () => {
    const { TimelineFeed } = await import("@/components/timeline/TimelineFeed");
    return { Timeline: renderServerComponent(<TimelineFeed />) };
  });

export const Route = createFileRoute("/_app/")({
  // Mandatory for the streaming variant: a re-run loader hands out a fresh
  // promise and would re-suspend the boundary on every revisit.
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  loader: async () => {
    const { Timeline } = await renderTimeline();
    return { Timeline };
  },
  head: ({ match }) =>
    routeHead(match, { title: "タイムライン — fog", path: "/" }),
  component: TimelinePage,
  errorComponent: ({ error }) => (
    <div className="fog-content" role="alert">
      <h2>読み込めませんでした</h2>
      <p>{sanitizeRouteError(error)}</p>
    </div>
  ),
});

function TimelinePage() {
  const { Timeline } = Route.useLoaderData();
  return (
    <Suspense fallback={<TimelineSkeleton />}>
      <Deferred promise={Timeline} />
    </Suspense>
  );
}
