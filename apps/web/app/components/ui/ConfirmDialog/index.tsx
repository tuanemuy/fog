"use client";

import { useEffect, useId, useRef } from "react";

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

/**
 * A native modal `<dialog>` in the shape of `.dialog-box`
 * (`spec/design/pages/timeline.html`). Mounted only while open so that
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

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only detects a hit on the backdrop; the keyboard path to the same cancel is the native Escape, which arrives through `onClose`
    <dialog
      ref={ref}
      className="fog-dialog"
      aria-labelledby={titleId}
      onClose={onCancel}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div className="fog-dialog-box">
        <h2 id={titleId} className="fog-dialog-title">
          {title}
        </h2>
        <p className="fog-dialog-text">{description}</p>
        <div className="fog-dialog-actions">
          <button
            type="button"
            className={danger ? "fog-danger" : "fog-primary"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? `${confirmLabel}中…` : confirmLabel}
          </button>
          <button
            type="button"
            className="fog-secondary"
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
