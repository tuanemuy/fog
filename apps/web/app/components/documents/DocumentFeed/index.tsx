import { Link } from "@tanstack/react-router";
import { KnowledgeNotFound } from "@/components/knowledge/KnowledgeNotFound";
import { OriginList } from "@/components/knowledge/OriginRow";
import { Markdown } from "@/components/ui/Markdown";
import { extractSerializedError } from "@/presentation/errorResponse";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { formatDateTime } from "@/presentation/time";
import { DocumentActions } from "../DocumentActions";
import {
  DOC_BODY_CLASS,
  DOC_CONTEXT_CLASS,
  DOC_CONTEXT_LINK_CLASS,
  DOC_META_CLASS,
  DOC_TITLE_CLASS,
} from "../styles";

const TITLE_ID = "document-title";

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
 * The streamed leaf of `/documents/:id` (P-08,
 * `spec/design/pages/document.html`): the topic, the title as the page's
 * `h1` (the route declares `h1: "sheet"`), the update time, the body in the
 * document typesetting and the memos it came from. The operations go into
 * the header. Absence and the trash are a screen state, not an error page.
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
    <article aria-labelledby={TITLE_ID}>
      <DocumentActions documentId={document.id} topicId={document.topicId} />
      <p className={DOC_CONTEXT_CLASS}>
        <Link
          to="/topics/$topicId"
          params={{ topicId: document.topicId }}
          className={DOC_CONTEXT_LINK_CLASS}
        >
          {topic.name}
        </Link>
      </p>
      <h1 id={TITLE_ID} className={DOC_TITLE_CLASS}>
        {document.title}
      </h1>
      <p className={DOC_META_CLASS}>
        <span>
          <time dateTime={document.updatedAt.toISOString()}>
            {formatDateTime(document.updatedAt)}
          </time>{" "}
          更新
        </span>
      </p>
      <div className={DOC_BODY_CLASS}>
        <Markdown body={document.body} variant="document" />
      </div>
      <OriginList memos={sources.sourceMemos} label="出典" />
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
