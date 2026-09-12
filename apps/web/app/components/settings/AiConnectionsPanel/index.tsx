"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { startTransition, useActionState, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Row } from "@/components/ui/Row";
import { RowError } from "@/components/ui/RowError";
import { useToast } from "@/components/ui/Toast";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { revokeAllAiClientConnectionsFn } from "../actions";
import { isConnectionsRevokedResult } from "../schema";

/** What stays on the row after a run: nothing, or the part that failed. */
type Outcome = Readonly<{ failure: string | null }>;

export function revokedMessage(revokedCount: number): string {
  return `失効しました（${revokedCount} 件）`;
}

export function notRevokedMessage(failedCount: number): string {
  return `${failedCount} 件は競合のため失効できませんでした`;
}

/**
 * P-03's AI-connection step (S-AC-06 「すべて失効」): the row at the end of
 * the connection list (`spec/design/pages/password-reset.html`,
 * `.revoke-all`), confirmed before it runs. The action is idempotent and an
 * OCC conflict on one connection does not stop the rest (design △-9), so an
 * answer can be a success and a partial failure at once. The two are split
 * — what was revoked is a toast; what could not be is a
 * row error that stays, with the retry. The per-connection listing is
 * `AiConnectionsList`.
 */
export function AiConnectionsPanel() {
  const revokeAll = useServerFn(revokeAllAiClientConnectionsFn);
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [outcome, run, pending] = useActionState<Outcome, void>(
    async () => {
      try {
        const result = readServerFnResult(
          await revokeAll({}),
          isConnectionsRevokedResult,
          "revokeAllAiClientConnectionsFn",
        );
        await router.invalidate();
        if (result.revokedCount > 0 || result.failedCount === 0) {
          toast(revokedMessage(result.revokedCount));
        }
        return {
          failure:
            result.failedCount > 0
              ? notRevokedMessage(result.failedCount)
              : null,
        };
      } catch (error) {
        return { failure: displayError(error) };
      }
    },
    { failure: null },
  );

  const start = () => startTransition(() => run());

  return (
    <div className="border-t border-neutral-100">
      <Row
        actions={
          <Button
            variant="danger-text"
            onClick={() => setConfirming(true)}
            disabled={pending}
          >
            {pending ? "失効中…" : "すべて失効"}
          </Button>
        }
        error={
          outcome.failure !== null && !pending ? (
            <RowError
              message={outcome.failure}
              retry={{ label: "リトライ", onRetry: start }}
            />
          ) : undefined
        }
      >
        <span className="text-sm font-medium">すべての接続</span>
      </Row>
      <ConfirmDialog
        open={confirming}
        title="すべての接続を失効しますか？"
        description="失効後は、接続しているすべてのAIから操作できなくなります。"
        confirmLabel="すべて失効"
        danger
        onConfirm={() => {
          setConfirming(false);
          start();
        }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
