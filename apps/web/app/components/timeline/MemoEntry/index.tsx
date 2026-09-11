"use client";

import type {
  ActorView,
  ConflictView,
  MemoView,
  TimelineItemView,
} from "@repo/core/application/memo/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  useActionState,
  useEffect,
  useOptimistic,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Markdown } from "@/components/ui/Markdown";
import {
  PopoverMenu,
  PopoverMenuItem,
  PopoverMenuLink,
} from "@/components/ui/PopoverMenu";
import { TextAreaField } from "@/components/ui/TextAreaField";
import {
  displayError,
  isOptimisticLockFailure,
} from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatTime } from "@/presentation/time";
import { editMemoFn } from "../actions";
import { SourceDocumentLinks } from "../SourceDocumentLinks";
import { isEditMemoResult } from "../schema";
import {
  ENTRY_BODY_CLASS,
  ENTRY_CLASS,
  ENTRY_HEAD_CLASS,
  HIGHLIGHTED_ENTRY_CLASS,
  TIME_LABEL_CLASS,
} from "../styles";

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
 * One memo on the timeline (`spec/design/pages/timeline.html`, `.entry`):
 * the time and the `…` menu (edit / history / delete) over the body, or the
 * inline editor in its place. Editing is an in-item change, so the leaf owns
 * the server function and an item-local `useOptimistic`; deleting changes
 * the list's membership, so it is handed up to the owner (CLAUDE.md,
 * Frontend).
 */
export function MemoEntry({
  memo,
  highlighted = false,
  onDelete,
  onSaved,
}: MemoEntryProps) {
  const router = useRouter();
  const edit = useServerFn(editMemoFn);
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
  const editor = useRef<HTMLTextAreaElement>(null);

  // The menu hands focus back to its trigger, which hides while the editor
  // is open; the editor takes it instead.
  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);

  const startEditing = () => {
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

  return (
    <article
      id={`memo-${memo.id}`}
      className={highlighted ? HIGHLIGHTED_ENTRY_CLASS : ENTRY_CLASS}
      aria-current={highlighted ? "true" : undefined}
      aria-busy={memo.pending || pending ? true : undefined}
    >
      <div className={ENTRY_HEAD_CLASS}>
        <time
          className={TIME_LABEL_CLASS}
          dateTime={memo.postedAt.toISOString()}
        >
          {formatTime(memo.postedAt)}
        </time>
        {memo.pending ? (
          <span role="status" className={TIME_LABEL_CLASS}>
            保存中…
          </span>
        ) : (
          // Hidden rather than removed while editing, so the head keeps its
          // height (`.entry.editing .entry-menu`).
          <span className={editing ? "invisible flex" : "flex"}>
            <PopoverMenu label="メモの操作">
              <PopoverMenuItem icon="edit" onSelect={startEditing}>
                編集
              </PopoverMenuItem>
              <PopoverMenuLink
                icon="history"
                to="/memos/$memoId/history"
                params={{ memoId: memo.id }}
              >
                履歴
              </PopoverMenuLink>
              <PopoverMenuItem
                icon="delete"
                tone="danger"
                onSelect={() => onDelete?.(memo)}
              >
                削除
              </PopoverMenuItem>
            </PopoverMenu>
          </span>
        )}
      </div>
      <div className={ENTRY_BODY_CLASS}>
        {editing ? (
          <form action={action} className="flex flex-col gap-sm">
            <TextAreaField
              ref={editor}
              label="メモを編集"
              hideLabel
              name="body"
              placeholder="メモを入力…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={pending}
              rows={2}
              maxLength={10_000}
            />
            {conflict && (
              <InlineAlert tone="warning">
                <p>
                  編集中に {actorLabel(conflict.latestRevision.actor)}{" "}
                  がこのメモを更新しました。そのまま保存すると、自分の内容が新しいリビジョンになります。
                </p>
                <p className="mt-sm font-medium">現在の本文</p>
                <p className="whitespace-pre-wrap">{conflict.currentBody}</p>
              </InlineAlert>
            )}
            {state.error && (
              <InlineAlert tone="error">{state.error}</InlineAlert>
            )}
            <div className="flex items-center justify-end gap-sm">
              <Button
                variant="text"
                onClick={() => {
                  setEditing(false);
                  setConflict(null);
                }}
                disabled={pending}
              >
                キャンセル
              </Button>
              <Button
                variant="fill-sm"
                type="submit"
                disabled={pending || draft.trim().length === 0}
              >
                {pending ? "保存中…" : conflict ? "そのまま保存" : "保存"}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <Markdown body={shownBody} variant="memo" />
            <SourceDocumentLinks documents={memo.sourceDocuments} />
          </>
        )}
      </div>
    </article>
  );
}
