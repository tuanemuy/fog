"use client";

import type {
  DocumentView,
  MemoView,
  TopicView,
} from "@repo/core/application/fog/types";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useOptimistic, useState } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { extractSerializedError } from "@/presentation/errorResponse";
import {
  createFogDocument,
  editFogDocument,
  loadFogDocument,
} from "@/presentation/fogDocumentActions";
import { DocumentSourcePicker } from "./DocumentSourcePicker";
import { Markdown } from "./Markdown";

type Context =
  | { mode: "new"; topic: TopicView }
  | { mode: "edit"; document: DocumentView };

export function DocumentEditor({ context }: { context: Context }) {
  const original = context.mode === "edit" ? context.document : null;
  const topicId =
    context.mode === "new" ? context.topic.id : context.document.topicId;
  const router = useRouter();
  const create = useServerFn(createFogDocument);
  const edit = useServerFn(editFogDocument);
  const load = useServerFn(loadFogDocument);
  const [title, setTitle] = useState(original?.title ?? "");
  const [body, setBody] = useState(original?.body ?? "");
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<MemoView[]>([]);
  const [conflict, setConflict] = useState<DocumentView | null>(null);
  const [preview, setPreview] = useState(false);
  const [savingPreview, showSaving] = useOptimistic<{
    title: string;
    body: string;
  } | null>(null);
  const [error, action, pending] = useActionState<string | null, FormData>(
    async (_previous, data) => {
      if (conflict && data.get("confirm") !== "on")
        return "最新の内容を確認してから保存してください。";
      showSaving({ title, body });
      try {
        const document = original
          ? await edit({
              data: {
                id: original.id,
                title,
                body,
                reason,
                expectedVersion: conflict?.version ?? original.version,
              },
            })
          : await create({
              data: {
                topicId,
                title,
                body,
                reason,
                sourceMemoIds: selected.map((memo) => memo.id),
              },
            });
        await router.invalidate();
        await router.navigate({
          to: "/documents/$documentId",
          params: { documentId: document.id },
        });
        return null;
      } catch (failure) {
        if (
          original &&
          extractSerializedError(failure).code === "OPTIMISTIC_LOCK_FAILURE"
        ) {
          try {
            setConflict(await load({ data: { id: original.id } }));
          } catch (readFailure) {
            return displayError(readFailure);
          }
          return "ほかの操作で更新されました。入力はそのまま残っています。最新の内容を確認してください。";
        }
        return displayError(failure);
      }
    },
    null,
  );
  return (
    <section className="fog-content" aria-busy={pending}>
      <Link
        className="fog-context-link"
        to="/topics/$topicId"
        params={{ topicId }}
      >
        {context.mode === "new" ? context.topic.title : "トピックへ"}
      </Link>
      <form action={action} className="fog-document-editor">
        <div className="fog-content-toolbar">
          <h2>{original ? "ドキュメントを編集" : "新しいドキュメント"}</h2>
          <button
            type="button"
            className="fog-text-button"
            onClick={() => setPreview(!preview)}
          >
            {preview ? "編集に戻る" : "プレビュー"}
          </button>
        </div>
        <label className="fog-sr-only" htmlFor="document-title">
          タイトル
        </label>
        <input
          id="document-title"
          name="title"
          className="fog-title-input"
          placeholder="タイトル"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          required
          disabled={pending}
        />
        {preview ? (
          <div className="fog-document-preview">
            <Markdown body={body} />
          </div>
        ) : (
          <>
            <label className="fog-sr-only" htmlFor="document-body">
              本文
            </label>
            <textarea
              id="document-body"
              name="body"
              className="fog-body-input"
              placeholder="本文を書く…"
              rows={14}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={1000000}
              disabled={pending}
            />
          </>
        )}
        <label className="fog-form-label" htmlFor="document-reason">
          変更理由（任意）
        </label>
        <input
          id="document-reason"
          name="reason"
          className="fog-field"
          placeholder="手動編集"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={1000}
          disabled={pending}
        />
        {context.mode === "new" && (
          <DocumentSourcePicker
            selected={selected}
            onChange={setSelected}
            disabled={pending}
          />
        )}
        {original && original.sourceMemos.length > 0 && (
          <section className="fog-source-picker">
            <h3>元になったメモ</h3>
            {original.sourceMemos.map((memo) => (
              <p className="fog-source-text" key={memo.id}>
                {memo.deleted ? "削除済みのメモ" : memo.body}
              </p>
            ))}
          </section>
        )}
        {conflict && (
          <div className="fog-conflict" role="alert">
            <h3>最新の内容（リビジョン {conflict.version}）</h3>
            <strong>{conflict.title}</strong>
            <Markdown body={conflict.body} />
            <label>
              <input type="checkbox" name="confirm" required />
              最新の変更を確認しました。入力中の内容を新しいリビジョンとして保存します。
            </label>
          </div>
        )}
        {error && (
          <p className="fog-error" role="alert">
            {error}
          </p>
        )}
        {savingPreview && (
          <div className="fog-saving-preview" role="status">
            <strong>{savingPreview.title}</strong>
            <p>保存中…</p>
            <Markdown body={savingPreview.body} compact />
          </div>
        )}
        <div className="fog-actions">
          <button
            type="submit"
            className="fog-primary"
            disabled={pending || !title.trim()}
          >
            {pending ? "保存中…" : conflict ? "確認した内容で保存" : "保存"}
          </button>
          {original ? (
            <Link
              className="fog-text-link"
              to="/documents/$documentId"
              params={{ documentId: original.id }}
            >
              キャンセル
            </Link>
          ) : (
            <Link
              className="fog-text-link"
              to="/topics/$topicId"
              params={{ topicId }}
            >
              キャンセル
            </Link>
          )}
        </div>
      </form>
    </section>
  );
}
