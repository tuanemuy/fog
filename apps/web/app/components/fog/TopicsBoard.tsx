"use client";

import type { TopicView } from "@repo/core/application/fog/types";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useOptimistic, useState } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { createFogTopic } from "@/presentation/fogDocumentActions";

type DisplayTopic = TopicView & { pending?: boolean };

export function TopicsBoard({ topics }: { topics: TopicView[] }) {
  const router = useRouter();
  const create = useServerFn(createFogTopic);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [optimistic, add] = useOptimistic<DisplayTopic[], DisplayTopic>(
    topics,
    (current, topic) => [topic, ...current],
  );
  const [error, action, pending] = useActionState<string | null, FormData>(
    async () => {
      const now = new Date().toISOString();
      add({
        id: `pending-${crypto.randomUUID()}`,
        title,
        description,
        completed: false,
        createdAt: now,
        updatedAt: now,
        version: 1,
        pending: true,
      });
      try {
        await create({ data: { title, description } });
        await router.invalidate();
        setTitle("");
        setDescription("");
        setAdding(false);
        return null;
      } catch (failure) {
        return displayError(failure);
      }
    },
    null,
  );
  const active = optimistic.filter((topic) => !topic.completed);
  const completed = optimistic.filter((topic) => topic.completed);
  const rows = (items: DisplayTopic[]) =>
    items.map((topic) =>
      topic.pending ? (
        <div className="fog-content-row fog-memo-pending" key={topic.id}>
          <strong>{topic.title}</strong>
          <p>{topic.description}</p>
          <span role="status">作成中…</span>
        </div>
      ) : (
        <Link
          key={topic.id}
          className="fog-content-row"
          to="/topics/$topicId"
          params={{ topicId: topic.id }}
        >
          <strong>{topic.title}</strong>
          {topic.description && <p>{topic.description}</p>}
          <span className="fog-row-arrow" aria-hidden="true">
            →
          </span>
        </Link>
      ),
    );
  return (
    <section
      className="fog-content"
      aria-label="トピック一覧"
      aria-busy={pending}
    >
      <div className="fog-content-toolbar">
        <h2>トピック</h2>
        <button
          className="fog-primary"
          type="button"
          onClick={() => setAdding(true)}
          disabled={adding}
        >
          新しいトピック
        </button>
      </div>
      {adding && (
        <form action={action} className="fog-editor-form">
          <h3>新しいトピック</h3>
          <label htmlFor="topic-title">名前</label>
          <input
            id="topic-title"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            required
            disabled={pending}
          />
          <label htmlFor="topic-description">説明（任意）</label>
          <textarea
            id="topic-description"
            name="description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
            rows={3}
            disabled={pending}
          />
          {error && (
            <p className="fog-error" role="alert">
              {error}
            </p>
          )}
          <div className="fog-actions">
            <button
              className="fog-primary"
              type="submit"
              disabled={pending || !title.trim()}
            >
              {pending ? "作成中…" : "作成"}
            </button>
            <button
              className="fog-text-button"
              type="button"
              disabled={pending}
              onClick={() => setAdding(false)}
            >
              キャンセル
            </button>
          </div>
        </form>
      )}
      {active.length > 0 ? (
        rows(active)
      ) : (
        <div className="fog-empty">
          <h2>
            {completed.length
              ? "進行中のトピックはありません"
              : "トピックを作ろう"}
          </h2>
          <p>考えたいテーマをひとつの場所に。</p>
        </div>
      )}
      {completed.length > 0 && (
        <details className="fog-completed">
          <summary>完了済み（{completed.length}）</summary>
          {rows(completed)}
        </details>
      )}
    </section>
  );
}
