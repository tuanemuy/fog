"use client";

import { type FormEvent, useLayoutEffect, useRef } from "react";
import { BottomDock } from "@/components/layout/ShellSlots";
import { ComposerError } from "@/components/ui/ComposerError";
import { Icon } from "@/components/ui/Icon";

export type ComposerProps = Readonly<{
  draft: string;
  onDraftChange: (draft: string) => void;
  /** The post, as a form action. */
  action: (formData: FormData) => void;
  /** Runs before the action; may stop the submit. */
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
  /** The last post's failure; the draft is still in the input. */
  error: string | null;
}>;

// A one-line pill whose height is exactly twice `--radius-lg`: the block
// padding is that radius less half a line, and the radius stays the same as
// it grows, so the corners never stretch into ovals (ADR-011 of Issue #22,
// `.composer.grows` in `spec/design/pages/timeline.html`).
const FORM_CLASS =
  "pointer-events-auto flex w-full max-w-narrow items-end gap-md rounded-lg bg-bg-input p-(--pad-input) py-[calc(var(--radius-lg)_-_0.5lh)] font-base text-base leading-normal text-neutral-900 shadow-md backdrop-blur-glass focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus";

// One line tall, so the glyph sits on the last line of a grown input.
const SUBMIT_CLASS =
  "flex h-[1lh] shrink-0 cursor-pointer items-center rounded-full px-xs font-base text-base leading-normal text-neutral-500 transition-colors enabled:hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:text-neutral-300";

const INPUT_CLASS =
  "max-h-[6lh] min-h-[1lh] min-w-[0] flex-1 resize-none overflow-y-auto bg-transparent font-base text-base leading-normal text-neutral-900 field-sizing-content outline-none placeholder:text-neutral-400";

const sizesByContent = (): boolean =>
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("field-sizing", "content");

/**
 * The memo composer, floating at the foot of the shell (`BottomDock`) with a
 * failed post right above it. The input is several lines: it grows with each
 * line break up to six lines and scrolls inside past that, while the pill
 * keeps its shape. The submit is the 「メモを追加」 glyph at its left end,
 * disabled while the draft is blank.
 */
export function Composer({
  draft,
  onDraftChange,
  action,
  onSubmit,
  pending,
  error,
}: ComposerProps) {
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Where the browser cannot size the input by its content, it is sized
  // here on every change; `max-h-[6lh]` still caps it.
  useLayoutEffect(() => {
    const element = input.current;
    if (element === null || sizesByContent()) return;
    element.style.height = "auto";
    if (draft !== "" && element.scrollHeight > 0) {
      element.style.height = `${element.scrollHeight}px`;
    }
  }, [draft]);

  return (
    <BottomDock>
      {error === null ? null : (
        <ComposerError
          message={error}
          retry={{
            label: "再試行",
            onRetry: () => form.current?.requestSubmit(),
          }}
        />
      )}
      <form
        ref={form}
        className={FORM_CLASS}
        action={action}
        onSubmit={onSubmit}
        aria-label="メモを投稿"
      >
        <button
          type="submit"
          aria-label="メモを追加"
          className={SUBMIT_CLASS}
          disabled={pending || draft.trim().length === 0}
        >
          <Icon name={pending ? "spinner" : "plus"} size="md" />
        </button>
        <textarea
          ref={input}
          name="body"
          aria-label="メモを入力"
          placeholder="メモを入力…"
          className={INPUT_CLASS}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          disabled={pending}
          rows={1}
          maxLength={10_000}
        />
      </form>
    </BottomDock>
  );
}
