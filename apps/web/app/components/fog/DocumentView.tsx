import type { DocumentView as Document } from "@repo/core/application/fog/types";
import { Link } from "@tanstack/react-router";
import { ContentDeletion } from "./ContentDeletion";
import { Markdown } from "./Markdown";

const date = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Tokyo",
});

export function DocumentView({ document }: { document: Document }) {
  return (
    <article className="fog-content fog-document">
      <Link
        className="fog-context-link"
        to="/topics/$topicId"
        params={{ topicId: document.topicId }}
      >
        ← トピックへ
      </Link>
      <div className="fog-content-toolbar">
        <h2>{document.title}</h2>
        <div className="fog-actions">
          <Link
            className="fog-text-link"
            to="/documents/$documentId/edit"
            params={{ documentId: document.id }}
          >
            編集
          </Link>
          <Link
            className="fog-text-link"
            to="/documents/$documentId/history"
            params={{ documentId: document.id }}
          >
            履歴
          </Link>
        </div>
      </div>
      <p className="fog-meta">
        更新 {date.format(new Date(document.updatedAt))}
      </p>
      {document.body ? (
        <Markdown body={document.body} />
      ) : (
        <p className="fog-empty-inline">本文はまだありません。</p>
      )}
      <div className="fog-section-heading">
        <h3>元になったメモ</h3>
        <span className="fog-meta">{document.sourceMemos.length}件</span>
      </div>
      {document.sourceMemos.length ? (
        document.sourceMemos.map((memo) =>
          memo.deleted ? (
            <div key={memo.id} className="fog-content-row">
              <span className="fog-meta">削除済みのメモ</span>
            </div>
          ) : (
            <Link
              className="fog-content-row"
              key={memo.id}
              to="/timeline"
              search={{ memoId: memo.id }}
            >
              <time className="fog-meta" dateTime={memo.createdAt}>
                {date.format(new Date(memo.createdAt))}
              </time>
              <p className="fog-source-text">{memo.body}</p>
              <span className="fog-row-arrow" aria-hidden="true">
                →
              </span>
            </Link>
          ),
        )
      ) : (
        <p className="fog-empty-inline">出典メモはありません。</p>
      )}
      <ContentDeletion
        target={{ kind: "document", id: document.id }}
        title={document.title}
        expectedVersion={document.version}
      />
    </article>
  );
}
