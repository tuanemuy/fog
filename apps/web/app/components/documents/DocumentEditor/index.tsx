"use client";

import type {
  DocumentConflictView,
  DocumentView,
  SourceMemoView,
} from "@repo/core/application/knowledge/view";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useActionState, useRef, useState } from "react";
import { OriginList } from "@/components/knowledge/OriginRow";
import { actorLabel } from "@/components/timeline/MemoEntry";
import {
  blankFieldMessage,
  displayError,
  isOptimisticLockFailure,
} from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatDateTime } from "@/presentation/time";
import { createDocumentFn, editDocumentFn } from "../actions";
import { type PickedMemo, SourceMemoPicker } from "../SourceMemoPicker";
import { isCreateDocumentResult, isEditDocumentResult } from "../schema";

export type DocumentEditorProps =
  | Readonly<{ mode: "create"; topicId: string; topicName: string }>
  | Readonly<{
      mode: "edit";
      document: DocumentView;
      topicName: string;
      sourceMemos: readonly SourceMemoView[];
    }>;

type EditorState = Readonly<{ error: string | null }>;

/**
 * P-09 in both modes. The form owns the save (CLAUDE.md, "add is
 * dispatched from the form's action"). Create posts no change reason (the
 * application writes 「作成」, △-3) and picks its sources here; edit shows
 * the existing sources read-only (△-4), takes an optional reason (blank →
 * 「手動編集」) and carries the `version` it opened with as the OCC token,
 * answering a conflict with the warning and 「そのまま保存」.
 */
export function DocumentEditor(props: DocumentEditorProps) {
  const router = useRouter();
  const create = useServerFn(createDocumentFn);
  const edit = useServerFn(editDocumentFn);
  const editing = props.mode === "edit" ? props.document : null;
  const [title, setTitle] = useState(editing?.title ?? "");
  const [titleMissing, setTitleMissing] = useState(false);
  const [body, setBody] = useState(editing?.body ?? "");
  const [changeReason, setChangeReason] = useState("");
  const [picked, setPicked] = useState<readonly PickedMemo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The OCC token the editor opened with; a refetch must not move it.
  const [expectedVersion] = useState(editing?.version ?? 0);
  const [conflict, setConflict] = useState<DocumentConflictView | null>(null);

  // Two submits in one frame both arrive before the pending state disables
  // the button; the second is stopped before React queues its action. A
  // blank title stops here too, so the message is all the submit produces
  // and the body stays as typed.
  const inFlight = useRef(false);
  const guardSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (inFlight.current) {
      event.preventDefault();
      return;
    }
    if (title.trim().length === 0) {
      event.preventDefault();
      setTitleMissing(true);
    }
  };

  const [state, action, pending] = useActionState<EditorState, FormData>(
    async (_previous, formData) => {
      const nextTitle = String(formData.get("title") ?? "");
      const nextBody = String(formData.get("body") ?? "");
      if (nextTitle.trim().length === 0) return { error: null };
      inFlight.current = true;
      try {
        if (props.mode === "create") {
          const created = readServerFnResult(
            await create({
              data: {
                topicId: props.topicId,
                title: nextTitle,
                body: nextBody,
                sourceMemoIds: picked.map((memo) => memo.memoId),
              },
            }),
            isCreateDocumentResult,
            "createDocumentFn",
          );
          await router.navigate({
            to: "/documents/$documentId",
            params: { documentId: created.id },
          });
          return { error: null };
        }
        const reason = String(formData.get("changeReason") ?? "").trim();
        const result = readServerFnResult(
          await edit({
            data: {
              documentId: props.document.id,
              title: nextTitle,
              body: nextBody,
              changeReason: reason.length > 0 ? reason : null,
              expectedVersion: conflict?.currentVersion ?? expectedVersion,
            },
          }),
          isEditDocumentResult,
          "editDocumentFn",
        );
        if (result.result === "conflict") {
          setConflict(result.conflict);
          return { error: null };
        }
        await router.navigate({
          to: "/documents/$documentId",
          params: { documentId: props.document.id },
        });
        return { error: null };
      } catch (failure) {
        if (isOptimisticLockFailure(failure)) await router.invalidate();
        return { error: displayError(failure) };
      } finally {
        inFlight.current = false;
      }
    },
    { error: null },
  );

  const topicId =
    props.mode === "create" ? props.topicId : props.document.topicId;

  return (
    <form
      className="fog-document-editor"
      action={action}
      onSubmit={guardSubmit}
      aria-label={
        props.mode === "create" ? "ドキュメントを作成" : "ドキュメントを編集"
      }
    >
      <div className="fog-content-toolbar">
        <p className="fog-document-context">
          <Link to="/topics/$topicId" params={{ topicId }}>
            {props.topicName}
          </Link>
        </p>
        <div className="fog-actions">
          {props.mode === "edit" ? (
            <Link
              to="/documents/$documentId"
              params={{ documentId: props.document.id }}
              className="fog-text-link"
            >
              編集をやめる
            </Link>
          ) : (
            <Link
              to="/topics/$topicId"
              params={{ topicId }}
              className="fog-text-link"
            >
              やめる
            </Link>
          )}
          <button type="submit" className="fog-primary" disabled={pending}>
            {pending ? "保存中…" : conflict ? "そのまま保存" : "保存"}
          </button>
        </div>
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
        onChange={(event) => {
          setTitle(event.target.value);
          setTitleMissing(false);
        }}
        disabled={pending}
        aria-invalid={titleMissing || undefined}
        aria-describedby={titleMissing ? "document-title-error" : undefined}
      />
      {titleMissing && (
        <p className="fog-error" id="document-title-error" role="alert">
          {blankFieldMessage("documentTitle")}
        </p>
      )}
      <label className="fog-sr-only" htmlFor="document-body">
        本文
      </label>
      <textarea
        id="document-body"
        name="body"
        className="fog-body-input"
        placeholder="本文を書く…"
        rows={16}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        disabled={pending}
      />
      {props.mode === "edit" && (
        <>
          <label className="fog-form-label" htmlFor="document-change-reason">
            変更理由
          </label>
          <input
            id="document-change-reason"
            name="changeReason"
            className="fog-field"
            placeholder="手動編集"
            value={changeReason}
            onChange={(event) => setChangeReason(event.target.value)}
            disabled={pending}
            maxLength={400}
          />
        </>
      )}
      {conflict && (
        <div className="fog-conflict" role="alert">
          <p>
            編集を開いた後に
            <strong>{actorLabel(conflict.latestRevision.actor)}</strong>
            が編集しました（
            {formatDateTime(conflict.latestRevision.createdAt)}・
            {conflict.latestRevision.changeReason}）。
          </p>
          <p className="fog-conflict-label">現在のタイトル</p>
          <pre className="fog-conflict-body">{conflict.currentTitle}</pre>
          <p className="fog-conflict-label">現在の本文</p>
          <pre className="fog-conflict-body">{conflict.currentBody}</pre>
          <p>
            そのまま保存すると、あなたの内容が最新の内容として新しいリビジョンに積まれます。
          </p>
        </div>
      )}
      {state.error && (
        <p className="fog-error" role="alert">
          {state.error}
        </p>
      )}
      {props.mode === "edit" ? (
        <OriginList memos={props.sourceMemos} label="出典" />
      ) : (
        <section className="fog-origin" aria-label="出典">
          <h3 className="fog-section-label">出典</h3>
          {picked.length === 0 ? (
            <p className="fog-empty-inline">出典メモはまだありません</p>
          ) : (
            <ul className="fog-source-selected-list">
              {picked.map((memo) => (
                <li key={memo.memoId} className="fog-source-selected">
                  <p>
                    <span className="fog-meta">
                      {formatDateTime(memo.postedAt)}
                    </span>
                    {memo.snippet}
                  </p>
                  <button
                    type="button"
                    className="fog-text-button"
                    onClick={() =>
                      setPicked((current) =>
                        current.filter((m) => m.memoId !== memo.memoId),
                      )
                    }
                  >
                    出典から外す
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="fog-add-item"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            <span className="fog-add-item-icon" aria-hidden="true">
              ＋
            </span>
            出典を追加
          </button>
          {pickerOpen && (
            <SourceMemoPicker
              picked={picked}
              onPick={(memo) =>
                setPicked((current) =>
                  current.some((m) => m.memoId === memo.memoId)
                    ? current
                    : [...current, memo],
                )
              }
            />
          )}
        </section>
      )}
    </form>
  );
}
