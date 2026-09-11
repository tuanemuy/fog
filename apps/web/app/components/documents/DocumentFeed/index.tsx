import { Link } from "@tanstack/react-router";
import { KnowledgeNotFound } from "@/components/knowledge/KnowledgeNotFound";
import { OriginList } from "@/components/knowledge/OriginRow";
import { Markdown } from "@/components/ui/Markdown";
import { extractSerializedError } from "@/presentation/errorResponse";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { formatDateTime } from "@/presentation/time";
import { DocumentActions } from "../DocumentActions";

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

/**
 * The streamed leaf of `/documents/:id` (P-08). Absence and the trash are
 * a screen state, not an error page.
 */
export async function DocumentFeed({ documentId }: { documentId: string }) {
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
  const { document, sources, topic } = data;
  return (
    <article className="fog-document" aria-labelledby="fog-document-title">
      <p className="fog-document-context">
        <Link to="/topics/$topicId" params={{ topicId: document.topicId }}>
          {topic.name}
        </Link>
      </p>
      <h2 id="fog-document-title" className="fog-document-title">
        {document.title}
      </h2>
      <p className="fog-document-meta">
        <time dateTime={document.updatedAt.toISOString()}>
          {formatDateTime(document.updatedAt)}
        </time>{" "}
        更新
      </p>
      <DocumentActions documentId={document.id} topicId={document.topicId} />
      <div className="fog-document-body">
        <Markdown body={document.body} variant="document" />
      </div>
      <OriginList memos={sources.sourceMemos} label="元になったメモ" />
    </article>
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
