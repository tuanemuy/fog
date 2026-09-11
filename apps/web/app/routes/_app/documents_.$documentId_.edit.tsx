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

const paramsSchema = z.object({ documentId: z.string().min(1).max(200) });

const renderDocumentEditor = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(paramsSchema))
  .handler(async ({ data }) => {
    const { DocumentEditorFeed } = await import(
      "@/components/documents/DocumentEditorFeed"
    );
    return {
      Editor: renderServerComponent(
        <DocumentEditorFeed documentId={data.documentId} />,
      ),
    };
  });

/** P-09, edit mode. The trailing `_` on the id segment keeps it off P-08's outlet. */
export const Route = createFileRoute("/_app/documents_/$documentId_/edit")({
  staticData: {
    header: {
      kind: "back",
      entity: "document",
      back: "/documents/$documentId",
      h1: "header",
    },
  },
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  loader: async ({ params }) => {
    const { Editor } = await renderDocumentEditor({
      data: { documentId: params.documentId },
    });
    return { Editor };
  },
  head: ({ match, params }) =>
    routeHead(match, {
      title: "ドキュメント編集 — fog",
      path: `/documents/${params.documentId}/edit`,
    }),
  component: DocumentEditPage,
  errorComponent: ({ error }) => (
    <div className="fog-content" role="alert">
      <h2>読み込めませんでした</h2>
      <p>{sanitizeRouteError(error)}</p>
    </div>
  ),
});

function DocumentEditPage() {
  const { Editor } = Route.useLoaderData();
  return (
    <div className="fog-content">
      <Suspense fallback={<DocumentSkeleton />}>
        <Deferred promise={Editor} />
      </Suspense>
    </div>
  );
}
