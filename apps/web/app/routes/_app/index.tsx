import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { timelineSearchSchema } from "@/components/timeline/search";
import { TimelineSkeleton } from "@/components/timeline/TimelineSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { streamingRouteOptions } from "@/presentation/streamingRoute";
import { validateInput } from "@/presentation/validator";

// Returns the UNRESOLVED promise so navigation settles at once and the list
// streams in under the skeleton.
const renderTimeline = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(timelineSearchSchema))
  .handler(async ({ data }) => {
    const { TimelineFeed } = await import("@/components/timeline/TimelineFeed");
    return { Timeline: renderServerComponent(<TimelineFeed search={data} />) };
  });

export const Route = createFileRoute("/_app/")({
  staticData: { header: { kind: "top", title: "タイムライン" } },
  // Mandatory for the streaming variant: a re-run loader hands out a fresh
  // promise and would re-suspend the boundary on every revisit.
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  // Never throws: every entry falls back to "absent" (`search.ts`).
  validateSearch: (search) => timelineSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const { Timeline } = await renderTimeline({ data: deps });
    return { Timeline };
  },
  head: ({ match }) =>
    routeHead(match, { title: "タイムライン — fog", path: "/" }),
  component: TimelinePage,
});

function TimelinePage() {
  const { Timeline } = Route.useLoaderData();
  return (
    <div className="pb-sheet-end-composer">
      <Suspense fallback={<TimelineSkeleton />}>
        <Deferred promise={Timeline} />
      </Suspense>
    </div>
  );
}
