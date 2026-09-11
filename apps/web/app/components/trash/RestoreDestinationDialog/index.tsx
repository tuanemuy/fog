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
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { TextAreaField } from "@/components/ui/TextAreaField";
import { TextField } from "@/components/ui/TextField";
import { blankFieldMessage, displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { loadRestoreDestinationsFn } from "../actions";
import { isTopicList } from "../schema";

export type RestoreDestination =
  | Readonly<{ kind: "existing"; topicId: string }>
  | Readonly<{ kind: "new"; name: string; description: string | null }>;

/**
 * A rejection of the previous choice, shown inside the dialog. `stale` marks
 * the one a fresh candidate list can fix (the chosen topic is gone), which
 * is the only case that offers 「候補を読み直す」.
 */
export type RestoreDestinationError = Readonly<{
  message: string;
  stale: boolean;
}>;

export type RestoreDestinationDialogProps = Readonly<{
  pending: boolean;
  error: RestoreDestinationError | null;
  onChoose: (destination: RestoreDestination) => void;
  onCancel: () => void;
}>;

type Candidates =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "failed"; message: string }>
  | Readonly<{ state: "ready"; topics: TopicListView["topics"] }>;

/** The radio value of 「新しいトピックを作成」; every other value is a topic id. */
const NEW_TOPIC = "new";

const OPTION_CLASS =
  "flex cursor-pointer items-center gap-sm border-neutral-100 py-md font-base text-base leading-tight text-neutral-900 not-first:border-t";
const RADIO_CLASS =
  "shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * ADR-001: the document's topic is gone, so the user picks where it goes —
 * an existing live topic (archived ones included) or a new one
 * (`spec/design/pages/trash.html`, 復元先選択). The candidates are fetched
 * when the dialog opens (decision △-5), and read again on request when the
 * chosen one turned out to be unavailable.
 */
export function RestoreDestinationDialog({
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
  const [choice, setChoice] = useState<string | null>(null);
  const [nameMissing, setNameMissing] = useState(false);
  const titleId = useId();

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
      setChoice((current) =>
        current !== null &&
        (current === NEW_TOPIC || list.topics.some((t) => t.id === current))
          ? current
          : (list.topics[0]?.id ?? NEW_TOPIC),
      );
    } catch (failure) {
      setCandidates({ state: "failed", message: displayError(failure) });
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || choice === null) return;
    if (choice !== NEW_TOPIC) {
      onChoose({ kind: "existing", topicId: choice });
      return;
    }
    const form = event.currentTarget;
    const name = (
      form.elements.namedItem("name") as HTMLInputElement
    ).value.trim();
    if (name.length === 0) {
      setNameMissing(true);
      return;
    }
    const description = (
      form.elements.namedItem("description") as HTMLTextAreaElement
    ).value.trim();
    onChoose({
      kind: "new",
      name,
      description: description.length > 0 ? description : null,
    });
  };

  const topics = candidates.state === "ready" ? candidates.topics : [];

  return (
    // `m-auto` puts the modal back in the middle of the viewport: the
    // preflight's blanket `margin: 0` otherwise pins it to the top left.
    <dialog
      ref={dialog}
      className="m-auto w-sheet max-w-narrow bg-transparent backdrop:bg-overlay"
      aria-labelledby={titleId}
      onClose={onCancel}
    >
      <form
        method="dialog"
        onSubmit={submit}
        aria-labelledby={titleId}
        className="rounded-lg bg-bg-card px-xl py-2xl font-base shadow-md"
      >
        <h2
          id={titleId}
          className="text-lg font-semibold leading-tight text-neutral-900"
        >
          復元先のトピック
        </h2>
        <p className="mt-md text-sm leading-normal text-neutral-700">
          元のトピックは完全に削除されています。
        </p>
        {error === null ? null : (
          <div className="mt-md">
            <InlineAlert
              tone="error"
              {...(error.stale && candidates.state === "ready"
                ? {
                    retry: {
                      label: "候補を読み直す",
                      onRetry: () => void reload(),
                    },
                  }
                : {})}
            >
              {error.message}
            </InlineAlert>
          </div>
        )}
        <fieldset className="mt-md min-w-[0]" disabled={pending}>
          <legend className="sr-only">復元先のトピック</legend>
          {candidates.state === "loading" && (
            <p
              role="status"
              className="py-md text-sm leading-tight text-neutral-600"
            >
              トピックを読み込み中…
            </p>
          )}
          {candidates.state === "failed" && (
            <InlineAlert
              tone="error"
              retry={{ label: "再試行", onRetry: () => void reload() }}
            >
              {candidates.message}
            </InlineAlert>
          )}
          <div>
            {topics.map((topic) => (
              <label key={topic.id} className={OPTION_CLASS}>
                <input
                  type="radio"
                  name="destination"
                  value={topic.id}
                  checked={choice === topic.id}
                  onChange={() => setChoice(topic.id)}
                  className={RADIO_CLASS}
                />
                {topic.name}
                {topic.status === "archived" ? "（完了）" : ""}
              </label>
            ))}
            <label className={OPTION_CLASS}>
              <input
                type="radio"
                name="destination"
                value={NEW_TOPIC}
                checked={choice === NEW_TOPIC}
                onChange={() => setChoice(NEW_TOPIC)}
                className={RADIO_CLASS}
              />
              新しいトピックを作成
            </label>
          </div>
        </fieldset>
        {choice === NEW_TOPIC && (
          <div className="mt-md flex flex-col gap-lg">
            <TextField
              label="トピック名"
              name="name"
              required
              maxLength={100}
              disabled={pending}
              autoComplete="off"
              error={nameMissing ? blankFieldMessage("topicName") : null}
              onChange={() => setNameMissing(false)}
            />
            <TextAreaField
              label="説明（任意）"
              name="description"
              rows={2}
              maxLength={500}
              disabled={pending}
            />
          </div>
        )}
        <div className="mt-xl flex flex-col gap-sm">
          <Button
            variant="fill-sm"
            type="submit"
            disabled={pending || choice === null}
          >
            {pending ? "復元中…" : "復元"}
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            キャンセル
          </Button>
        </div>
      </form>
    </dialog>
  );
}
