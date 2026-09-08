import { KnowledgeNotFound } from "@/components/knowledge/KnowledgeNotFound";
import { extractSerializedError } from "@/presentation/errorResponse";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { DocumentEditor } from "../DocumentEditor";

const loadDocument = serverData(
  () => import("@repo/core/application/knowledge/getDocument"),
  async ({ container }, { getDocument }, userId: string, documentId: string) =>
    getDocument({ container, input: { userId, documentId } }),
);

const loadSources = serverData(
  () => import("@repo/core/application/knowledge/listDocumentSourceMemos"),
  async (
    { container },
    { listDocumentSourceMemos },
    userId: string,
    documentId: string,
  ) => listDocumentSourceMemos({ container, input: { userId, documentId } }),
);

const loadTopicName = serverData(
  () => import("@repo/core/application/knowledge/getTopicName"),
  async ({ container }, { getTopicName }, userId: string, topicId: string) =>
    getTopicName({ container, input: { userId, topicId } }),
);

/** The streamed leaf of `/documents/:id/edit` (P-09, edit mode). */
export async function DocumentEditorFeed({
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
    <DocumentEditor
      key={data.document.id}
      mode="edit"
      document={data.document}
      topicName={data.topic.name}
      sourceMemos={data.sources.sourceMemos}
    />
  );
}

async function loadPage(userId: string, documentId: string) {
  const document = await loadDocument(userId, documentId);
  const [sources, topic] = await Promise.all([
    loadSources(userId, documentId),
    loadTopicName(userId, document.topicId),
  ]);
  return { document, sources, topic };
}
