"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/Button";

export type ConfirmDialogProps = Readonly<{
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** A destructive confirmation gets the red button and focus ring. */
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}>;

// The dialog's own two buttons (`.dialog-confirm` / `.dialog-cancel` in
// `spec/design/pages/trash.html`). A non-destructive confirmation is the
// `fill-sm` step as it is; these two exist only here, so they are not steps
// of `Button`.
const DIALOG_BUTTON =
  "inline-flex cursor-pointer items-center justify-center rounded-full p-(--pad-btn-sm) font-base text-sm font-medium leading-tight [border:var(--border-input)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:text-neutral-300";
const DANGER_CONFIRM_CLASS = `${DIALOG_BUTTON} bg-bg-card text-error focus-visible:outline-focus-danger not-disabled:hover:bg-error-bg`;
const CANCEL_CLASS = `${DIALOG_BUTTON} bg-transparent text-neutral-600 focus-visible:outline-focus not-disabled:hover:bg-neutral-50`;

/**
 * A native modal `<dialog>` in the shape of `.dialog-box`
 * (`spec/design/pages/trash.html`): title, one sentence, then the confirm
 * and cancel buttons stacked full width. Mounted only while open so that
 * `showModal()` runs once per opening; Escape and backdrop clicks reach
 * `onCancel` through the element's `close` event.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null;
  return <OpenDialog {...props} />;
}

function OpenDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "キャンセル",
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // jsdom has no `showModal`; the attribute keeps the element visible there.
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);

  const confirmText = pending ? `${confirmLabel}中…` : confirmLabel;

  return (
    // The click only detects a hit on the backdrop, which is the `<dialog>`
    // itself around the box — hence the box inside it rather than on it. The
    // keyboard path to the same cancel is the native Escape, through `onClose`.
    // `m-auto` puts the modal back in the middle of the viewport: the
    // preflight's blanket `margin: 0` otherwise pins it to the top left.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <dialog
      ref={ref}
      className="m-auto w-sheet max-w-narrow bg-transparent backdrop:bg-overlay"
      aria-labelledby={titleId}
      onClose={onCancel}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div className="rounded-lg bg-bg-card px-xl py-2xl font-base shadow-md">
        <h2
          id={titleId}
          className="text-lg font-semibold leading-tight text-neutral-900"
        >
          {title}
        </h2>
        <p className="mt-md text-sm leading-normal text-neutral-700">
          {description}
        </p>
        <div className="mt-xl flex flex-col gap-sm">
          {danger ? (
            <button
              type="button"
              className={DANGER_CONFIRM_CLASS}
              onClick={onConfirm}
              disabled={pending}
            >
              {confirmText}
            </button>
          ) : (
            <Button variant="fill-sm" onClick={onConfirm} disabled={pending}>
              {confirmText}
            </Button>
          )}
          <button
            type="button"
            className={CANCEL_CLASS}
            onClick={onCancel}
            disabled={pending}
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
