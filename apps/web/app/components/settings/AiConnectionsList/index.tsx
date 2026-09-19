"use client";

import type { AiClientConnectionView } from "@repo/core/application/identity/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Row } from "@/components/ui/Row";
import { RowError } from "@/components/ui/RowError";
import { RowList } from "@/components/ui/RowList";
import {
  displayError,
  isOptimisticLockFailure,
} from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatDate, formatDateTime } from "@/presentation/time";
import { revokeAiClientConnectionFn } from "../actions";
import { ItemMeta, ItemName, SectionEmpty } from "../SettingsSection";
import { isConnectionRevokedResult } from "../schema";

type RowFailure = Readonly<{ connectionId: string; message: string }>;

/**
 * The empty list's sentence. The MCP URL stays in it: nowhere else in the app
 * tells the user what to add to the client.
 */
export function emptyMessage(mcpUrl: string): string {
  return `接続しているAIはありません。AIアプリの設定で fog（${mcpUrl}）を追加すると接続できます。`;
}

/**
 * The connected AI clients (S-AC-06, P-13 / P-03), owned as a list:
 * revocation removes the row optimistically, the server function runs
 * here, and a rejection puts the row back with its reason under it. Only
 * active connections are drawn; a revoked one is a fact the screens do not
 * show.
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
  const [failure, setFailure] = useState<RowFailure | null>(null);
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
    setFailure(null);
    startTransition(async () => {
      remove(target.connectionId);
      try {
        readServerFnResult(
          await revoke({ data: { connectionId: target.connectionId } }),
          isConnectionRevokedResult,
          "revokeAiClientConnectionFn",
        );
        await router.invalidate();
      } catch (error) {
        // A concurrent revocation already did the work: the refetch shows it.
        if (isOptimisticLockFailure(error)) {
          await router.invalidate();
          return;
        }
        setFailure({
          connectionId: target.connectionId,
          message: displayError(error),
        });
      }
    });
  };

  return (
    <div>
      {shown.length === 0 ? (
        <SectionEmpty>{emptyMessage(mcpUrl)}</SectionEmpty>
      ) : (
        <RowList aria-label="接続しているAI">
          {shown.map((connection) => (
            <li key={connection.connectionId}>
              <Row
                actions={
                  <Button
                    variant="danger-text"
                    onClick={() => setConfirming(connection)}
                    aria-label={`${connection.clientName} の接続を解除`}
                  >
                    接続を解除
                  </Button>
                }
                error={
                  failure?.connectionId === connection.connectionId ? (
                    <RowError message={failure.message} />
                  ) : undefined
                }
              >
                <ItemName>{connection.clientName}</ItemName>
                <ItemMeta>
                  接続: {formatDate(connection.connectedAt)}
                  <br />
                  最終利用:{" "}
                  {connection.lastUsedAt === null
                    ? "未使用"
                    : formatDateTime(connection.lastUsedAt)}
                </ItemMeta>
              </Row>
            </li>
          ))}
        </RowList>
      )}
      <ConfirmDialog
        open={confirming !== null}
        title="接続を解除しますか？"
        description={
          confirming === null
            ? ""
            : `解除後は、${confirming.clientName} から操作できなくなります。`
        }
        confirmLabel="接続を解除"
        danger
        onConfirm={onConfirm}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
