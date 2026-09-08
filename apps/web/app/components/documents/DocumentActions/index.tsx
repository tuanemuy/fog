"use client";

import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { trashDocumentFn } from "../actions";
import { isTrashDocumentResult } from "../schema";

/**
 * P-08's operations: edit and history are links, delete is a confirmed
 * soft delete that leaves the screen for the topic. The page itself goes
 * away, so no optimistic state is kept here (PH-03 §4.5).
 */
export function DocumentActions({
  documentId,
  topicId,
}: {
  documentId: string;
  topicId: string;
}) {
  const router = useRouter();
  const trash = useServerFn(trashDocumentFn);
  const [confirming, setConfirming] = useState(false);
  const [deleting, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = () =>
    startDelete(async () => {
      try {
        readServerFnResult(
          await trash({ data: { documentId } }),
          isTrashDocumentResult,
          "trashDocumentFn",
        );
        await router.navigate({ to: "/topics/$topicId", params: { topicId } });
      } catch (failure) {
        setConfirming(false);
        setError(displayError(failure));
      }
    });

  return (
    <div className="fog-document-actions">
      <div className="fog-actions">
        <Link
          to="/documents/$documentId/edit"
          params={{ documentId }}
          className="fog-text-link"
        >
          編集
        </Link>
        <Link
          to="/documents/$documentId/history"
          params={{ documentId }}
          className="fog-text-link"
        >
          履歴
        </Link>
        <button
          type="button"
          className="fog-text-button fog-danger-text"
          onClick={() => setConfirming(true)}
        >
          削除
        </button>
      </div>
      {error && (
        <p className="fog-error" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title="ドキュメントを削除しますか？"
        description="ドキュメントはゴミ箱に移動し、保持期限を過ぎると完全に削除されます。ゴミ箱から元に戻せます。"
        confirmLabel="削除"
        danger
        pending={deleting}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!deleting) setConfirming(false);
        }}
      />
    </div>
  );
}
