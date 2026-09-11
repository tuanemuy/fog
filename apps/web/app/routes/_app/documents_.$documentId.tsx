import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { z } from "zod";
import { DocumentSkeleton } from "@/components/documents/DocumentSkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { streamingRouteOptions } from "@/presentation/streamingRoute";
import { validateInput } from "@/presentation/validator";

const paramsSchema = z.object({ documentId: z.string().min(1).max(200) });

const renderDocument = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(paramsSchema))
  .handler(async ({ data }) => {
    const { DocumentFeed } = await import(
      "@/components/documents/DocumentFeed"
    );
    return {
      Document: renderServerComponent(
        <DocumentFeed documentId={data.documentId} />,
      ),
    };
  });

/** P-08. `documents_` keeps it out of any `/documents` layout the tree may grow. */
export const Route = createFileRoute("/_app/documents_/$documentId")({
  staticData: {
    header: { kind: "back", entity: "document", back: "/topics", h1: "header" },
  },
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  loader: async ({ params }) => {
    const { Document } = await renderDocument({
      data: { documentId: params.documentId },
    });
    return { Document };
  },
  head: ({ match, params }) =>
    routeHead(match, {
      title: "ドキュメント — fog",
      path: `/documents/${params.documentId}`,
    }),
  component: DocumentPage,
});

function DocumentPage() {
  const { Document } = Route.useLoaderData();
  return (
    <div className="pb-sheet-end">
      <Suspense fallback={<DocumentSkeleton />}>
        <Deferred promise={Document} />
      </Suspense>
    </div>
  );
}
