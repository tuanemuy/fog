import { KnowledgeNotFound } from "@/components/knowledge/KnowledgeNotFound";
import { extractSerializedError } from "@/presentation/errorResponse";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { DocumentRevisionHistory } from "../DocumentRevisionHistory";

const loadRevisions = serverData(
  () => import("@repo/core/application/knowledge/listDocumentRevisions"),
  async (
    { container },
    { listDocumentRevisions },
    userId: string,
    documentId: string,
  ) => listDocumentRevisions({ container, input: { userId, documentId } }),
);

const loadDocument = serverData(
  () => import("@repo/core/application/knowledge/getDocument"),
  async ({ container }, { getDocument }, userId: string, documentId: string) =>
    getDocument({ container, input: { userId, documentId } }),
);

/**
 * The streamed leaf of `/documents/:id/history` (P-10). The history is
 * readable for a trashed document too; its title then comes from the
 * latest revision rather than the (absent) active row.
 */
export async function DocumentHistoryFeed({
  documentId,
}: {
  documentId: string;
}) {
  let data: Awaited<ReturnType<typeof loadPage>>;
  try {
    data = await guardStreamedRender(async () => {
      const { requireUserId } = await import("@/presentation/currentUser");
      const userId = await requireUserId();
      return loadPage(userId, documentId);
    });
  } catch (error) {
    if (extractSerializedError(error).kind === "notFound") {
      return <KnowledgeNotFound subject="ドキュメント" />;
    }
    throw error;
  }
  return (
    <DocumentRevisionHistory
      key={documentId}
      documentId={data.revisions.documentId}
      title={data.title}
      latestRevision={data.revisions.latestRevision}
      revisions={data.revisions.revisions}
    />
  );
}

async function loadPage(userId: string, documentId: string) {
  const revisions = await loadRevisions(userId, documentId);
  let title = "ドキュメント";
  try {
    title = (await loadDocument(userId, documentId)).title;
  } catch (error) {
    // A trashed document has a history but no active row to name it.
    if (extractSerializedError(error).kind !== "notFound") throw error;
  }
  return { revisions, title };
}
