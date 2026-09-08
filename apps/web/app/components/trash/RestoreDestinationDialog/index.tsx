"use client";

import type { TopicListView } from "@repo/core/application/knowledge/view";
import { useServerFn } from "@tanstack/react-start";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { loadRestoreDestinationsFn } from "../actions";
import { isTopicList } from "../schema";

export type RestoreDestination =
  | Readonly<{ kind: "existing"; topicId: string }>
  | Readonly<{ kind: "new"; name: string; description: string | null }>;

export type RestoreDestinationDialogProps = Readonly<{
  documentTitle: string;
  pending: boolean;
  /** A rejection of the previous choice, shown inside the dialog. */
  error: string | null;
  onChoose: (destination: RestoreDestination) => void;
  onCancel: () => void;
}>;

type Candidates =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "failed"; message: string }>
  | Readonly<{ state: "ready"; topics: TopicListView["topics"] }>;

/**
 * ADR-001: the document's topic is gone, so the user picks where it goes —
 * an existing live topic (archived ones included) or a new one. The
 * candidates are fetched when the dialog opens (decision △-5), and read
 * again on request when the chosen one turned out to be unavailable.
 */
export function RestoreDestinationDialog({
  documentTitle,
  pending,
  error,
  onChoose,
  onCancel,
}: RestoreDestinationDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const load = useServerFn(loadRestoreDestinationsFn);
  const [candidates, setCandidates] = useState<Candidates>({
    state: "loading",
  });
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const nameId = useId();
  const descriptionId = useId();
  const selectId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
  }, []);

  const reload = useCallback(async () => {
    setCandidates({ state: "loading" });
    try {
      const list = readServerFnResult(
        await load({}),
        isTopicList,
        "loadRestoreDestinationsFn",
      );
      setCandidates({ state: "ready", topics: list.topics });
      if (list.topics.length === 0) setMode("new");
    } catch (failure) {
      setCandidates({ state: "failed", message: displayError(failure) });
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    if (mode === "existing") {
      const topicId = (
        form.elements.namedItem("topicId") as HTMLSelectElement | null
      )?.value;
      if (!topicId) return;
      onChoose({ kind: "existing", topicId });
      return;
    }
    const name = (
      form.elements.namedItem("name") as HTMLInputElement
    ).value.trim();
    if (name.length === 0) return;
    const description = (
      form.elements.namedItem("description") as HTMLTextAreaElement
    ).value.trim();
    onChoose({
      kind: "new",
      name,
      description: description.length > 0 ? description : null,
    });
  };

  const hasCandidates =
    candidates.state === "ready" && candidates.topics.length > 0;

  return (
    <dialog
      ref={dialog}
      className="fog-dialog fog-destination"
      aria-labelledby="restore-destination-title"
      onClose={onCancel}
    >
      <form method="dialog" onSubmit={submit} aria-label="復元先のトピック">
        <h2 id="restore-destination-title" className="fog-dialog-title">
          「{documentTitle}」の復元先を選んでください
        </h2>
        <p className="fog-dialog-description">
          元のトピックは完全に削除されています。既存のトピックへ戻すか、新しいトピックを作って戻します。
        </p>
        <fieldset className="fog-destination-choice" disabled={pending}>
          <legend className="fog-sr-only">復元先の種類</legend>
          <label>
            <input
              type="radio"
              name="mode"
              value="existing"
              checked={mode === "existing"}
              disabled={!hasCandidates}
              onChange={() => setMode("existing")}
            />
            既存のトピックへ
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              value="new"
              checked={mode === "new"}
              onChange={() => setMode("new")}
            />
            新しいトピックを作る
          </label>
        </fieldset>
        {mode === "existing" && (
          <div className="fog-destination-existing">
            {candidates.state === "loading" && (
              <p className="fog-meta" role="status">
                トピックを読み込み中…
              </p>
            )}
            {candidates.state === "failed" && (
              <p className="fog-error" role="alert">
                {candidates.message}
                <button
                  type="button"
                  className="fog-text-button"
                  onClick={() => void reload()}
                >
                  読み直す
                </button>
              </p>
            )}
            {candidates.state === "ready" && !hasCandidates && (
              <p className="fog-meta">
                選べるトピックがありません。新しいトピックを作ってください。
              </p>
            )}
            {hasCandidates && (
              <>
                <label htmlFor={selectId} className="fog-sr-only">
                  復元先のトピック
                </label>
                <select id={selectId} name="topicId" disabled={pending}>
                  {candidates.topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.name}
                      {topic.status === "archived" ? "（完了）" : ""}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        )}
        {mode === "new" && (
          <div className="fog-destination-new">
            <label htmlFor={nameId}>トピック名</label>
            <input
              id={nameId}
              name="name"
              type="text"
              required
              maxLength={100}
              disabled={pending}
              autoComplete="off"
            />
            <label htmlFor={descriptionId}>説明（任意）</label>
            <textarea
              id={descriptionId}
              name="description"
              rows={2}
              maxLength={500}
              disabled={pending}
            />
          </div>
        )}
        {error !== null && (
          <p className="fog-error" role="alert">
            {error}
            {candidates.state === "ready" && (
              <button
                type="button"
                className="fog-text-button"
                onClick={() => void reload()}
              >
                候補を読み直す
              </button>
            )}
          </p>
        )}
        <div className="fog-dialog-actions">
          <button
            type="button"
            className="fog-secondary"
            onClick={onCancel}
            disabled={pending}
          >
            キャンセル
          </button>
          <button
            type="submit"
            className="fog-primary"
            disabled={pending || (mode === "existing" && !hasCandidates)}
          >
            {pending ? "復元中…" : "この場所へ復元"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
