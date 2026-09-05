"use client";
import { type ReactNode, useEffect, useRef } from "react";

export function ConfirmDialog({
  title,
  children,
  pending,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  pending: boolean;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="fog-confirm-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
    >
      <h2>{title}</h2>
      {children}
      <button
        type="button"
        className="fog-text-button"
        disabled={pending}
        onClick={onCancel}
      >
        キャンセル
      </button>
    </dialog>
  );
}
