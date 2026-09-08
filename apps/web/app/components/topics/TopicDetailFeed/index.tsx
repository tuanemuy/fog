import type { TopicDetailView } from "@repo/core/application/knowledge/view";
import { Link } from "@tanstack/react-router";
import { KnowledgeNotFound } from "@/components/knowledge/KnowledgeNotFound";
import { OriginList } from "@/components/knowledge/OriginRow";
import { extractSerializedError } from "@/presentation/errorResponse";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { formatDay } from "@/presentation/time";
import { TopicHeader } from "../TopicHeader";

const loadTopic = serverData(
  () => import("@repo/core/application/knowledge/getTopic"),
  async ({ container }, { getTopic }, userId: string, topicId: string) =>
    getTopic({ container, input: { userId, topicId } }),
);

function JumpIcon() {
  return (
    <span className="fog-doc-row-jump">
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
      >
        <path
          d="M5 15L15 5M15 5H7.5M15 5V12.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** The document list of P-07, `updatedAt` descending as the usecase promises. */
export function TopicDocuments({
  topicId,
  documents,
}: {
  topicId: string;
  documents: TopicDetailView["documents"];
}) {
  return (
    <section aria-label="ドキュメント">
      <h3 className="fog-section-label">ドキュメント</h3>
      {documents.length === 0 ? (
        <p className="fog-empty-inline">まだドキュメントがありません</p>
      ) : (
        <div className="fog-doc-rows">
          {documents.map((document) => (
            <Link
              key={document.id}
              className="fog-doc-row"
              to="/documents/$documentId"
              params={{ documentId: document.id }}
            >
              <span className="fog-doc-row-main">
                <span className="fog-doc-row-name">{document.title}</span>
                <span className="fog-doc-row-meta">
                  {formatDay(document.updatedAt)} 更新
                </span>
              </span>
              <JumpIcon />
            </Link>
          ))}
        </div>
      )}
      <Link
        className="fog-add-item"
        to="/topics/$topicId/documents/new"
        params={{ topicId }}
      >
        <span className="fog-add-item-icon" aria-hidden="true">
          ＋
        </span>
        新しいドキュメント
      </Link>
    </section>
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
      return <KnowledgeNotFound subject="トピック" />;
    }
    throw error;
  }
  return (
    <div className="fog-topic-detail">
      <TopicHeader key={detail.topic.id} topic={detail.topic} />
      <TopicDocuments topicId={detail.topic.id} documents={detail.documents} />
      <OriginList memos={detail.relatedMemos} label="関連メモ" />
    </div>
  );
}
