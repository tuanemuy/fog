"use client";

import type {
  TopicDetail as Detail,
  TopicView,
} from "@repo/core/application/fog/types";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useOptimistic, useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { extractSerializedError } from "@/presentation/errorResponse";
import {
  loadFogTopic,
  updateFogTopic,
} from "@/presentation/fogDocumentActions";

import { ContentDeletion } from "./ContentDeletion";

const date = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Tokyo",
});

export function TopicDetail({ detail }: { detail: Detail }) {
  const { topic, documents, relatedMemos } = detail;
  const router = useRouter();
  const update = useServerFn(updateFogTopic);
  const load = useServerFn(loadFogTopic);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(topic.title);
  const [description, setDescription] = useState(topic.description);
  const [conflict, setConflict] = useState<TopicView | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggling, transition] = useTransition();
  const [shown, optimistic] = useOptimistic(topic);
  const [error, action, pending] = useActionState<string | null, FormData>(
    async (_previous, data) => {
      if (conflict && data.get("confirm") !== "on")
        return "最新の内容を確認してから保存してください。";
      optimistic({ ...topic, title, description });
      try {
        await update({
          data: {
            id: topic.id,
            title,
            description,
            completed: conflict?.completed ?? topic.completed,
            expectedVersion: conflict?.version ?? topic.version,
          },
        });
        await router.invalidate();
        setConflict(null);
        setEditing(false);
        return null;
      } catch (failure) {
        if (
          extractSerializedError(failure).code === "OPTIMISTIC_LOCK_FAILURE"
        ) {
          try {
            setConflict((await load({ data: { id: topic.id } })).topic);
          } catch (readFailure) {
            return displayError(readFailure);
          }
          return "ほかの操作で更新されました。最新の内容を確認してください。";
        }
        return displayError(failure);
      }
    },
    null,
  );
  const toggle = () =>
    transition(async () => {
      optimistic({ ...topic, completed: !topic.completed });
      setToggleError(null);
      try {
        await update({
          data: {
            id: topic.id,
            title: topic.title,
            description: topic.description,
            completed: !topic.completed,
            expectedVersion: topic.version,
          },
        });
        await router.invalidate();
      } catch (failure) {
        setToggleError(displayError(failure));
        if (extractSerializedError(failure).code === "OPTIMISTIC_LOCK_FAILURE")
          await router.invalidate();
      }
    });
  return (
    <section className="fog-content" aria-busy={pending || toggling}>
      <div className="fog-content-toolbar">
        <h2>{shown.title}</h2>
        {shown.completed && <span className="fog-badge">完了済み</span>}
        <details className="fog-inline-menu">
          <summary>操作</summary>
          <div>
            <button
              type="button"
              className="fog-text-button"
              disabled={pending || toggling}
              onClick={() => {
                setTitle(topic.title);
                setDescription(topic.description);
                setEditing(true);
              }}
            >
              編集
            </button>
            <button
              type="button"
              className="fog-text-button"
              onClick={toggle}
              disabled={pending || toggling}
            >
              {shown.completed ? "完了を解除" : "完了にする"}
            </button>
          </div>
        </details>
      </div>
      {shown.description && (
        <p className="fog-description">{shown.description}</p>
      )}
      {toggleError && (
        <p className="fog-error" role="alert">
          {toggleError}
        </p>
      )}
      {editing && (
        <form className="fog-editor-form" action={action}>
          <label htmlFor="edit-topic-title">名前</label>
          <input
            id="edit-topic-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={200}
            disabled={pending}
          />
          <label htmlFor="edit-topic-description">説明（任意）</label>
          <textarea
            id="edit-topic-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            maxLength={2000}
            disabled={pending}
          />
          {conflict && (
            <div className="fog-conflict" role="alert">
              <strong>最新の内容</strong>
              <p>{conflict.title}</p>
              <p>{conflict.description}</p>
              <label>
                <input name="confirm" type="checkbox" required />
                最新の変更を確認しました。入力中の内容で保存します。
              </label>
            </div>
          )}
          {error && (
            <p role="alert" className="fog-error">
              {error}
            </p>
          )}
          <div className="fog-actions">
            <button
              type="submit"
              className="fog-primary"
              disabled={pending || !title.trim()}
            >
              {pending ? "保存中…" : conflict ? "確認した内容で保存" : "保存"}
            </button>
            <button
              type="button"
              className="fog-text-button"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setConflict(null);
              }}
            >
              キャンセル
            </button>
          </div>
        </form>
      )}
      <div className="fog-section-heading">
        <h3>ドキュメント</h3>
        <Link
          className="fog-text-link"
          to="/topics/$topicId/new"
          params={{ topicId: topic.id }}
        >
          新しいドキュメント
        </Link>
      </div>
      {documents.length ? (
        documents.map((document) => (
          <Link
            className="fog-content-row"
            key={document.id}
            to="/documents/$documentId"
            params={{ documentId: document.id }}
          >
            <strong>{document.title}</strong>
            <span className="fog-meta">
              更新 {date.format(new Date(document.updatedAt))}
            </span>
            <span className="fog-row-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        ))
      ) : (
        <p className="fog-empty-inline">まだドキュメントはありません。</p>
      )}
      <div className="fog-section-heading">
        <h3>関連メモ</h3>
        <span className="fog-meta">{relatedMemos.length}件</span>
      </div>
      {relatedMemos.length ? (
        relatedMemos.map((memo) => (
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
        ))
      ) : (
        <p className="fog-empty-inline">出典にしたメモがここに表示されます。</p>
      )}
      <ContentDeletion
        target={{ kind: "topic", id: topic.id }}
        title={topic.title}
        expectedVersion={topic.version}
      />
    </section>
  );
}
