"use client";

import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { HeaderActions } from "@/components/layout/ShellSlots";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconButton } from "@/components/ui/IconButton";
import { IconButtonLink } from "@/components/ui/IconButtonLink";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { useToast } from "@/components/ui/Toast";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { trashDocumentFn } from "../actions";
import { isTrashDocumentResult } from "../schema";
import { SHEET_ALERTS_CLASS } from "../styles";

// The id of the screen these operations sit on, read without importing the
// route module: that module pulls `@tanstack/react-start/rsc` in, which is
// not the island's to carry.
const route = getRouteApi("/_app/documents_/$documentId");

/**
 * P-08's operations, as the header's icons (`spec/design/pages/document.html`,
 * `.ops-actions`): edit and history are links, delete is a confirmed soft
 * delete that leaves the screen for the topic with a toast. The page itself
 * goes away, so no optimistic state is kept here (PH-03 §4.5). A failed
 * delete stays on the page, at the head of the sheet where this is placed,
 * with a retry of the delete already confirmed.
 */
export function DocumentActions({
  documentId,
  topicId,
}: {
  documentId: string;
  topicId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const trash = useServerFn(trashDocumentFn);
  const [confirming, setConfirming] = useState(false);
  const [deleting, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const runDelete = () =>
    startDelete(async () => {
      let trashed = false;
      try {
        readServerFnResult(
          await trash({ data: { documentId } }),
          isTrashDocumentResult,
          "trashDocumentFn",
        );
        trashed = true;
        toast("ドキュメントを削除しました");
        // The topic screen is cached with this document still in its list.
        // This screen is the one just deleted, so its own loader stays out of
        // the re-read: it would draw 「ドキュメントが見つかりません」 over the
        // page — dialog included — before the navigation lands.
        await router.invalidate({
          filter: (match) => match.routeId !== route.id,
        });
        await router.navigate({ to: "/topics/$topicId", params: { topicId } });
      } catch (failure) {
        // The server already confirmed the delete, so a failure past that
        // point is the reconciliation's: reporting it here would offer a
        // retry of something already in the trash.
        if (trashed) return;
        setConfirming(false);
        setError(displayError(failure));
      }
    });

  return (
    <>
      <HeaderActions>
        <IconButtonLink
          to="/documents/$documentId/edit"
          params={{ documentId }}
          icon="edit"
          label="編集"
          size="md"
          placement="header"
        />
        <IconButtonLink
          to="/documents/$documentId/history"
          params={{ documentId }}
          icon="history"
          label="履歴を表示"
          size="md"
          placement="header"
        />
        <IconButton
          icon="delete"
          label="削除"
          size="md"
          placement="header"
          tone="danger"
          disabled={deleting}
          onClick={() => setConfirming(true)}
        />
      </HeaderActions>
      {error === null ? null : (
        <div className={SHEET_ALERTS_CLASS}>
          <InlineAlert
            tone="error"
            retry={{
              label: "再試行",
              onRetry: () => {
                setError(null);
                runDelete();
              },
            }}
          >
            {error}
          </InlineAlert>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title="削除しますか？"
        description="このドキュメントはゴミ箱に移動します。ゴミ箱から元に戻せます。"
        confirmLabel="削除"
        danger
        pending={deleting}
        onConfirm={runDelete}
        onCancel={() => {
          if (!deleting) setConfirming(false);
        }}
      />
    </>
  );
}
