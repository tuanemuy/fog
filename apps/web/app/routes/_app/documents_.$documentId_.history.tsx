import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { z } from "zod";
import { MemoHistorySkeleton } from "@/components/memoHistory/MemoHistorySkeleton";
import { Deferred } from "@/components/ui/Deferred";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { streamingRouteOptions } from "@/presentation/streamingRoute";
import { validateInput } from "@/presentation/validator";

const paramsSchema = z.object({ documentId: z.string().min(1).max(200) });

const renderDocumentHistory = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(paramsSchema))
  .handler(async ({ data }) => {
    const { DocumentHistoryFeed } = await import(
      "@/components/documents/DocumentHistoryFeed"
    );
    return {
      History: renderServerComponent(
        <DocumentHistoryFeed documentId={data.documentId} />,
      ),
    };
  });

/** P-10. Same shape as the memo history; the skeleton is the same rows. */
export const Route = createFileRoute("/_app/documents_/$documentId_/history")({
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
    const { History } = await renderDocumentHistory({
      data: { documentId: params.documentId },
    });
    return { History };
  },
  head: ({ match, params }) =>
    routeHead(match, {
      title: "ドキュメント履歴 — fog",
      path: `/documents/${params.documentId}/history`,
    }),
  component: DocumentHistoryPage,
});

function DocumentHistoryPage() {
  const { History } = Route.useLoaderData();
  return (
    <div className="pb-sheet-end">
      <Suspense fallback={<MemoHistorySkeleton />}>
        <Deferred promise={History} />
      </Suspense>
    </div>
  );
}
