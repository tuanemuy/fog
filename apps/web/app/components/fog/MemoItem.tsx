"use client";

import type { MemoView } from "@repo/core/application/fog/types";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  useActionState,
  useEffect,
  useOptimistic,
  useRef,
  useState,
} from "react";
import { displayError } from "@/presentation/errorDisplay";
import { extractSerializedError } from "@/presentation/errorResponse";
import { editFogMemo, loadFogMemo } from "@/presentation/fogMemoActions";
import { Markdown } from "./Markdown";

const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Tokyo",
});
export function MemoItem({
  memo,
  onSaved,
  onDelete,
}: {
  memo: MemoView & { pending?: boolean };
  onSaved: (memo: MemoView) => void;
  onDelete: (memo: MemoView) => void;
}) {
  const router = useRouter();
  const edit = useServerFn(editFogMemo);
  const reload = useServerFn(loadFogMemo);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memo.body);
  const [expected, setExpected] = useState(memo.version);
  const [conflict, setConflict] = useState<MemoView | null>(null);
  const [optimistic, setOptimistic] = useOptimistic(memo);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (editing) dialog.current?.showModal();
    else dialog.current?.close();
  }, [editing]);
  const [error, save, pending] = useActionState<string | null, FormData>(
    async () => {
      if (!draft.trim()) return "本文を入力してください。";
      setOptimistic({ ...memo, body: draft });
      try {
        const saved = await edit({
          data: { id: memo.id, body: draft, expectedVersion: expected },
        });
        onSaved(saved);
        await router.invalidate();
        setConflict(null);
        setEditing(false);
        return null;
      } catch (failure) {
        if (
          extractSerializedError(failure).code === "OPTIMISTIC_LOCK_FAILURE"
        ) {
          try {
            const latest = await reload({ data: { id: memo.id } });
            setExpected(latest.version);
            setConflict(latest);
            return null;
          } catch (reloadFailure) {
            return displayError(reloadFailure);
          }
        }
        return displayError(failure);
      }
    },
    null,
  );
  return (
    <article
      id={`memo-${memo.id}`}
      className={`fog-memo${memo.pending ? " fog-memo-pending" : ""}`}
      aria-busy={pending || memo.pending}
    >
      <div className="fog-memo-meta">
        <time dateTime={memo.createdAt}>
          {timeFormatter.format(new Date(memo.createdAt))}
        </time>
        {(memo.pending || pending) && <span role="status">保存中…</span>}
        {!memo.pending && (
          <details className="fog-item-menu">
            <summary aria-label="メモの操作">•••</summary>
            <div>
              <button
                type="button"
                onClick={() => {
                  setDraft(memo.body);
                  setExpected(memo.version);
                  setConflict(null);
                  setEditing(true);
                }}
              >
                編集
              </button>
              <Link to="/memos/$memoId/history" params={{ memoId: memo.id }}>
                履歴
              </Link>
              <button type="button" onClick={() => onDelete(memo)}>
                削除
              </button>
            </div>
          </details>
        )}
      </div>
      <Markdown body={optimistic.body} compact />
      {memo.sourceDocuments.length > 0 && (
        <nav
          className="fog-source-links"
          aria-label="このメモを出典とするドキュメント"
        >
          {memo.sourceDocuments.map((source) =>
            source.deleted ? (
              <span key={source.id}>削除済みのドキュメント</span>
            ) : (
              <Link
                key={source.id}
                to="/documents/$documentId"
                params={{ documentId: source.id }}
              >
                → {source.title}
              </Link>
            ),
          )}
        </nav>
      )}
      <dialog
        className="fog-editor-dialog"
        ref={dialog}
        onCancel={(event) => {
          if (pending) event.preventDefault();
          else setEditing(false);
        }}
      >
        <form action={save} aria-label="メモを編集">
          <div className="fog-section-heading">
            <h2>メモを編集</h2>
            <button
              type="button"
              className="fog-text-button"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              閉じる
            </button>
          </div>
          <label htmlFor={`edit-${memo.id}`} className="fog-sr-only">
            メモの本文
          </label>
          <textarea
            id={`edit-${memo.id}`}
            rows={8}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={100000}
            disabled={pending}
          />
          {conflict && (
            <section className="fog-conflict" role="alert">
              <h3>編集中に内容が更新されました</h3>
              <p>
                最新の内容は版 {conflict.version}{" "}
                です。確認して保存すると、両方の内容が履歴に残ります。
              </p>
              <details>
                <summary>最新の内容を確認</summary>
                <Markdown body={conflict.body} compact />
              </details>
              <button
                type="button"
                className="fog-text-button"
                onClick={() => {
                  setDraft(conflict.body);
                  setConflict(null);
                }}
              >
                最新の内容を編集する
              </button>
            </section>
          )}
          {error && (
            <p role="alert" className="fog-error">
              {error}
            </p>
          )}
          <div className="fog-form-actions">
            <button
              type="button"
              className="fog-secondary"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="fog-primary"
              disabled={pending || !draft.trim()}
            >
              {pending
                ? "保存中…"
                : conflict
                  ? "確認して自分の内容を保存"
                  : "保存"}
            </button>
          </div>
        </form>
      </dialog>
    </article>
  );
}
