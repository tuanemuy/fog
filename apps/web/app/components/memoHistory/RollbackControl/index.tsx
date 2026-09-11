"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { useToast } from "@/components/ui/Toast";
import { displayError } from "@/presentation/errorDisplay";

/**
 * - `rolledBack` — a new version with the base's content was stacked, and
 *   the screen has already left for where the result shows
 * - `unchanged` — the current content already is the base's; nothing moved
 */
export type RollbackOutcome = "rolledBack" | "unchanged";

export type RollbackControlProps = Readonly<{
  /** When the base was written — the words that name it on this screen. */
  baseTime: string;
  /**
   * Stacks the base's content as a new version and, when that changed
   * anything, leaves for where the result shows. Rejects with the failure.
   */
  rollback: () => Promise<RollbackOutcome>;
}>;

export const UNCHANGED_NOTICE = "現在の内容は既にこのリビジョンと同じです";

/**
 * 「この内容に戻す」 for the base (`.action-row` in
 * `spec/design/pages/memo-history.html`): what it acts on, the button, and
 * the confirmation before anything is written. The outcome is a toast — it
 * outlives this screen, which a successful rollback leaves — and a failure
 * stays under the button. Key it by the base so a new base starts clean.
 */
export function RollbackControl({ baseTime, rollback }: RollbackControlProps) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pending, startRollback] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const confirm = () =>
    startRollback(async () => {
      try {
        const outcome = await rollback();
        if (outcome === "rolledBack") {
          toast(`${baseTime} の内容に戻しました`);
          return;
        }
        setConfirming(false);
        setError(null);
        toast(UNCHANGED_NOTICE);
      } catch (failure) {
        setConfirming(false);
        setError(displayError(failure));
      }
    });

  return (
    <>
      <div className="mt-lg flex flex-wrap items-center justify-end gap-x-md gap-y-sm">
        <span className="font-base text-xs leading-tight text-neutral-600 tabular-nums">
          比較元 · {baseTime}
        </span>
        <Button variant="fill" onClick={() => setConfirming(true)}>
          この内容に戻す
        </Button>
      </div>
      {error === null ? null : (
        <div className="mt-md">
          <InlineAlert tone="error">{error}</InlineAlert>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title="この内容に戻しますか？"
        description={`${baseTime} の内容で新しいリビジョンを作ります。これまでの履歴は残ります。`}
        confirmLabel="戻す"
        pending={pending}
        onConfirm={confirm}
        onCancel={() => {
          if (!pending) setConfirming(false);
        }}
      />
    </>
  );
}
