"use client";

import type {
  ActorView,
  ConflictView,
  MemoView,
  TimelineItemView,
} from "@repo/core/application/memo/view";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  useActionState,
  useEffect,
  useId,
  useOptimistic,
  useRef,
  useState,
} from "react";
import {
  displayError,
  isOptimisticLockFailure,
} from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatDateTime, formatTime } from "@/presentation/time";
import { editMemoFn } from "../actions";
import { Markdown } from "../Markdown";
import { SourceDocumentLinks } from "../SourceDocumentLinks";
import { isEditMemoResult } from "../schema";

export type DisplayMemo = TimelineItemView & { pending?: boolean };

/** Decision J-H: the user reads as 「あなた」; an AI client by its name. */
export function actorLabel(actor: ActorView): string {
  return actor.kind === "user" ? "あなた" : actor.clientName;
}

type EditState = Readonly<{ error: string | null }>;

export type MemoEntryProps = Readonly<{
  memo: DisplayMemo;
  /** The memo a position-specified visit asked for (P-04). */
  highlighted?: boolean;
  /** Asks the list owner to run the delete; the leaf never runs it itself. */
  onDelete?: (memo: DisplayMemo) => void;
  /** The saved memo, for the owner to re-base its list onto. */
  onSaved?: (memo: MemoView) => void;
}>;

/**
 * One memo on the timeline: the entry, its menu (edit / history / delete)
 * and the inline editor. Editing is an in-item change, so the leaf owns the
 * server function and an item-local `useOptimistic`; deleting changes the
 * list's membership, so it is handed up to the owner (CLAUDE.md, Frontend).
 */
export function MemoEntry({
  memo,
  highlighted = false,
  onDelete,
  onSaved,
}: MemoEntryProps) {
  const router = useRouter();
  const edit = useServerFn(editMemoFn);
  const editorId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memo.body);
  // The OCC token the editor started from. Held apart from `memo.version`
  // so a refetch while the editor is open cannot hide another writer.
  const [startedVersion, setStartedVersion] = useState(memo.version);
  const [conflict, setConflict] = useState<ConflictView | null>(null);
  const [shownBody, showBody] = useOptimistic(
    memo.body,
    (_current: string, next: string) => next,
  );

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const startEditing = () => {
    setMenuOpen(false);
    setDraft(memo.body);
    setStartedVersion(memo.version);
    setConflict(null);
    setEditing(true);
  };

  const [state, action, pending] = useActionState<EditState, FormData>(
    async (_previous, formData) => {
      const body = String(formData.get("body") ?? "");
      // The button is disabled for a blank draft; only a programmatic submit
      // reaches here with one.
      if (body.trim().length === 0) return { error: null };
      // "Save anyway" re-submits on top of the version the warning showed.
      const expectedVersion = conflict?.currentVersion ?? startedVersion;
      showBody(body);
      try {
        const result = readServerFnResult(
          await edit({ data: { memoId: memo.id, body, expectedVersion } }),
          isEditMemoResult,
          "editMemoFn",
        );
        if (result.result === "conflict") {
          setConflict(result.conflict);
          return { error: null };
        }
        if (result.result === "saved") {
          onSaved?.(result.memo);
          await router.invalidate();
        }
        setConflict(null);
        setEditing(false);
        return { error: null };
      } catch (failure) {
        // The rare OCC race past the conflict check: refetch so the next
        // attempt starts from the current version.
        if (isOptimisticLockFailure(failure)) await router.invalidate();
        return { error: displayError(failure) };
      }
    },
    { error: null },
  );

  const className = [
    "fog-memo",
    memo.pending ? "fog-memo-pending" : "",
    highlighted ? "fog-memo-highlight" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      id={`memo-${memo.id}`}
      className={className}
      aria-busy={memo.pending || pending ? true : undefined}
    >
      <div className="fog-memo-meta">
        <time dateTime={memo.postedAt.toISOString()}>
          {formatTime(memo.postedAt)}
        </time>
        {memo.pending ? (
          <span role="status">保存中…</span>
        ) : (
          <div className="fog-entry-menu-wrap" ref={menuRef}>
            <button
              type="button"
              className="fog-entry-menu"
              aria-label="メモの操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg
                aria-hidden="true"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
              >
                <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                <circle cx="13" cy="8" r="1.4" fill="currentColor" />
              </svg>
            </button>
            {menuOpen && (
              <div className="fog-entry-pop" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="fog-pop-item"
                  onClick={startEditing}
                >
                  編集
                </button>
                <Link
                  role="menuitem"
                  className="fog-pop-item"
                  to="/memos/$memoId/history"
                  params={{ memoId: memo.id }}
                >
                  履歴
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  className="fog-pop-item fog-pop-danger"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete?.(memo);
                  }}
                >
                  削除
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {editing ? (
        <form
          className="fog-inline-edit"
          action={action}
          aria-label="メモを編集"
        >
          <label className="fog-sr-only" htmlFor={editorId}>
            本文
          </label>
          <textarea
            id={editorId}
            name="body"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={pending}
            rows={4}
            maxLength={10_000}
          />
          {conflict && (
            <div className="fog-conflict" role="alert">
              <p>
                編集を始めた後に
                <strong>{actorLabel(conflict.latestRevision.actor)}</strong>
                がこのメモを編集しました（
                {formatDateTime(conflict.latestRevision.createdAt)}）。
              </p>
              <p className="fog-conflict-label">現在の本文</p>
              <pre className="fog-conflict-body">{conflict.currentBody}</pre>
              <p>
                そのまま保存すると、あなたの本文が最新の内容として新しいリビジョンに積まれます。
              </p>
            </div>
          )}
          {state.error && (
            <p className="fog-error" role="alert">
              {state.error}
            </p>
          )}
          <div className="fog-actions">
            <button
              type="submit"
              className="fog-primary"
              disabled={pending || draft.trim().length === 0}
            >
              {pending ? "保存中…" : conflict ? "そのまま保存" : "保存"}
            </button>
            <button
              type="button"
              className="fog-secondary"
              onClick={() => {
                setEditing(false);
                setConflict(null);
              }}
              disabled={pending}
            >
              取り消し
            </button>
          </div>
        </form>
      ) : (
        <>
          <Markdown body={shownBody} />
          <SourceDocumentLinks documents={memo.sourceDocuments} />
        </>
      )}
    </article>
  );
}
