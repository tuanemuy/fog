"use client";

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogActions,
  DialogCancelButton,
  DialogDangerButton,
} from "@/components/ui/Dialog";

export type ConfirmDialogProps = Readonly<{
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  /**
   * What the confirmation reads while it runs. The default is
   * `${confirmLabel}中…`, which only reads as Japanese when the label is a
   * noun-like verb (「削除」「接続を解除」); a label that is a plain verb
   * (「戻す」「空にする」) passes its own.
   */
  pendingLabel?: string;
  cancelLabel?: string;
  /** A destructive confirmation gets the red button and focus ring. */
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}>;

/**
 * The `Dialog` with the one question it was drawn for: title, one sentence,
 * then the confirm and cancel buttons stacked full width. Mounted only while
 * open so that the dialog opens once per opening.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pendingLabel,
  cancelLabel = "キャンセル",
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  const confirmText = pending
    ? (pendingLabel ?? `${confirmLabel}中…`)
    : confirmLabel;
  return (
    <Dialog
      title={title}
      description={description}
      locked={pending}
      onClose={onCancel}
    >
      <DialogActions>
        {danger ? (
          <DialogDangerButton onClick={onConfirm} disabled={pending}>
            {confirmText}
          </DialogDangerButton>
        ) : (
          <Button variant="fill-sm" onClick={onConfirm} disabled={pending}>
            {confirmText}
          </Button>
        )}
        <DialogCancelButton onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </DialogCancelButton>
      </DialogActions>
    </Dialog>
  );
}
