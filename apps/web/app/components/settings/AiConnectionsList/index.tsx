"use client";

import type { AiClientConnectionView } from "@repo/core/application/identity/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  displayError,
  isOptimisticLockFailure,
} from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatDateTime, formatDay } from "@/presentation/time";
import { revokeAiClientConnectionFn } from "../actions";
import { isConnectionRevokedResult } from "../schema";

/**
 * The connected AI clients (S-AC-06, P-13 / P-03), owned as a list:
 * revocation removes the row optimistically, the server function runs
 * here, and a rejection puts the row back with its reason. Only active
 * connections are drawn; a revoked one is a fact the screens do not show.
 */
export function AiConnectionsList({
  connections,
  mcpUrl,
}: {
  connections: readonly AiClientConnectionView[];
  /** What a client is told to add as its connector when there is none yet. */
  mcpUrl: string;
}) {
  const router = useRouter();
  const revoke = useServerFn(revokeAiClientConnectionFn);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AiClientConnectionView | null>(
    null,
  );
  const [shown, remove] = useOptimistic<
    readonly AiClientConnectionView[],
    string
  >(
    connections.filter((c) => c.status === "active"),
    (current, connectionId) =>
      current.filter((c) => c.connectionId !== connectionId),
  );

  const onConfirm = () => {
    const target = confirming;
    if (target === null) return;
    setConfirming(null);
    setError(null);
    startTransition(async () => {
      remove(target.connectionId);
      try {
        readServerFnResult(
          await revoke({ data: { connectionId: target.connectionId } }),
          isConnectionRevokedResult,
          "revokeAiClientConnectionFn",
        );
        await router.invalidate();
      } catch (failure) {
        // A concurrent revocation already did the work: the refetch shows it.
        if (isOptimisticLockFailure(failure)) {
          await router.invalidate();
          return;
        }
        setError(displayError(failure));
      }
    });
  };

  return (
    <div className="fog-ai-connections">
      {shown.length === 0 ? (
        <>
          <p className="fog-meta">接続はありません。</p>
          <p className="fog-meta">
            LLM アプリで fog
            をコネクタとして追加すると、このブラウザで認可画面が開きます。MCP
            サーバーの URL: <code>{mcpUrl}</code>
          </p>
        </>
      ) : (
        <ul className="fog-settings-list" aria-label="接続済み AI クライアント">
          {shown.map((connection) => (
            <li key={connection.connectionId} className="fog-settings-row">
              <span>{connection.clientName}</span>
              <span className="fog-meta">
                接続済み: {formatDay(connection.connectedAt)}
                {" / "}
                最終利用:{" "}
                {connection.lastUsedAt === null
                  ? "未使用"
                  : formatDateTime(connection.lastUsedAt)}
              </span>
              <button
                type="button"
                className="fog-text-button"
                onClick={() => setConfirming(connection)}
                aria-label={`${connection.clientName} の接続を解除`}
              >
                接続を解除
              </button>
            </li>
          ))}
        </ul>
      )}
      {error !== null && (
        <p className="fog-error" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming !== null}
        title="接続を解除しますか？"
        description={
          confirming === null
            ? ""
            : `「${confirming.clientName}」の接続を解除すると、このクライアントは fog を操作できなくなります。再び使うには認可をやり直します。`
        }
        confirmLabel="解除する"
        danger
        onConfirm={onConfirm}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
