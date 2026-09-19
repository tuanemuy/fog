import type { TopicDetailView } from "@repo/core/application/knowledge/view";
import { KnowledgeNotFound } from "@/components/knowledge/KnowledgeNotFound";
import { OriginList } from "@/components/knowledge/OriginRow";
import { RowLink } from "@/components/ui/RowLink";
import { RowList } from "@/components/ui/RowList";
import { SheetSection } from "@/components/ui/SheetSection";
import { extractSerializedError } from "@/presentation/errorResponse";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { formatDay } from "@/presentation/time";
import { AddRowLink } from "../AddRow";
import { DOCUMENT_META_CLASS, DOCUMENT_NAME_CLASS } from "../styles";
import { TopicHeader } from "../TopicHeader";

const loadTopic = serverData(
  () => import("@repo/core/application/knowledge/getTopic"),
  async ({ container }, { getTopic }, userId: string, topicId: string) =>
    getTopic({ container, input: { userId, topicId } }),
);

/**
 * The documents of P-07, `updatedAt` descending as the usecase promises
 * (`spec/design/pages/topic-detail.html`): each a `RowLink` to P-08, and
 * 「新しいドキュメント」 last. With no document the add row is all there is.
 */
export function TopicDocuments({
  topicId,
  documents,
}: {
  topicId: string;
  documents: TopicDetailView["documents"];
}) {
  return (
    <SheetSection label="ドキュメント" level={2}>
      <RowList>
        {documents.map((document) => (
          <li key={document.id}>
            <RowLink
              to="/documents/$documentId"
              params={{ documentId: document.id }}
            >
              <span className={DOCUMENT_NAME_CLASS}>{document.title}</span>
              <span className={DOCUMENT_META_CLASS}>
                {formatDay(document.updatedAt)} 更新
              </span>
            </RowLink>
          </li>
        ))}
        <li>
          <AddRowLink to="/topics/$topicId/documents/new" params={{ topicId }}>
            新しいドキュメント
          </AddRowLink>
        </li>
      </RowList>
    </SheetSection>
  );
}

/**
 * The streamed leaf of `/topics/:id`: the header island, the documents and
 * the related memos. Absence is a screen state (`KnowledgeNotFound`).
 */
export async function TopicDetailFeed({ topicId }: { topicId: string }) {
  let detail: TopicDetailView;
  try {
    detail = await guardStreamedRender(async () => {
      const { requireUserId } = await import("@/presentation/currentUser");
      const userId = await requireUserId();
      return loadTopic(userId, topicId);
    });
  } catch (error) {
    if (extractSerializedError(error).kind === "notFound") {
      return <KnowledgeNotFound subject="トピック" asPageHeading />;
    }
    throw error;
  }
  return (
    <>
      <TopicHeader key={detail.topic.id} topic={detail.topic} />
      <TopicDocuments topicId={detail.topic.id} documents={detail.documents} />
      <OriginList memos={detail.relatedMemos} label="関連メモ" level={2} />
    </>
  );
}
