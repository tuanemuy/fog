import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { z } from "zod";
import { DocumentSkeleton } from "@/components/documents/DocumentSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { streamingRouteOptions } from "@/presentation/streamingRoute";
import { validateInput } from "@/presentation/validator";

const paramsSchema = z.object({ topicId: z.string().min(1).max(200) });

const renderDocumentComposer = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(paramsSchema))
  .handler(async ({ data }) => {
    const { DocumentComposerFeed } = await import(
      "@/components/documents/DocumentComposerFeed"
    );
    return {
      Composer: renderServerComponent(
        <DocumentComposerFeed topicId={data.topicId} />,
      ),
    };
  });

/** P-09, create mode. The topic is fixed by where the user came from (P-07). */
export const Route = createFileRoute("/_app/topics_/$topicId_/documents/new")({
  staticData: {
    header: {
      kind: "back",
      entity: "document",
      back: "/topics/$topicId",
      h1: "header",
    },
  },
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  loader: async ({ params }) => {
    const { Composer } = await renderDocumentComposer({
      data: { topicId: params.topicId },
    });
    return { Composer };
  },
  head: ({ match, params }) =>
    routeHead(match, {
      title: "ドキュメント作成 — fog",
      path: `/topics/${params.topicId}/documents/new`,
    }),
  component: DocumentComposerPage,
  errorComponent: ({ error }) => (
    <div className="fog-content" role="alert">
      <h2>読み込めませんでした</h2>
      <p>{sanitizeRouteError(error)}</p>
    </div>
  ),
});

function DocumentComposerPage() {
  const { Composer } = Route.useLoaderData();
  return (
    <div className="fog-content">
      <Suspense fallback={<DocumentSkeleton />}>
        <Deferred promise={Composer} />
      </Suspense>
    </div>
  );
}
