import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { z } from "zod";
import { TopicDetailSkeleton } from "@/components/topics/TopicDetailSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { streamingRouteOptions } from "@/presentation/streamingRoute";
import { validateInput } from "@/presentation/validator";

const topicParamsSchema = z.object({ topicId: z.string().min(1).max(200) });

const renderTopic = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(topicParamsSchema))
  .handler(async ({ data }) => {
    const { TopicDetailFeed } = await import(
      "@/components/topics/TopicDetailFeed"
    );
    return {
      Topic: renderServerComponent(<TopicDetailFeed topicId={data.topicId} />),
    };
  });

/** P-07. `topics_` keeps it out of the list's layout. */
export const Route = createFileRoute("/_app/topics_/$topicId")({
  staticData: {
    header: { kind: "back", entity: "topic", back: "/topics", h1: "header" },
  },
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  loader: async ({ params }) => {
    const { Topic } = await renderTopic({
      data: { topicId: params.topicId },
    });
    return { Topic };
  },
  head: ({ match, params }) =>
    routeHead(match, {
      title: "トピック — fog",
      path: `/topics/${params.topicId}`,
    }),
  component: TopicPage,
});

function TopicPage() {
  const { Topic } = Route.useLoaderData();
  return (
    <div className="pb-sheet-end">
      <Suspense fallback={<TopicDetailSkeleton />}>
        <Deferred promise={Topic} />
      </Suspense>
    </div>
  );
}
