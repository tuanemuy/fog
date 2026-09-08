"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { revokeAllAiClientConnectionsFn } from "../actions";
import { isConnectionsRevokedResult } from "../schema";

type State = Readonly<{
  error: string | null;
  revokedCount: number | null;
  failedCount: number;
}>;

/**
 * P-03's AI-connection step (S-AC-06 「すべて失効」): one idempotent action,
 * always available, that reports how many connections it ended and how
 * many it could not (an OCC conflict on one row does not stop the rest;
 * design △-9). The per-connection listing is `AiConnectionsList` on P-13.
 */
export function AiConnectionsPanel() {
  const revokeAll = useServerFn(revokeAllAiClientConnectionsFn);
  const router = useRouter();
  const [state, action, pending] = useActionState<State, FormData>(
    async () => {
      try {
        const result = readServerFnResult(
          await revokeAll({}),
          isConnectionsRevokedResult,
          "revokeAllAiClientConnectionsFn",
        );
        await router.invalidate();
        return {
          error: null,
          revokedCount: result.revokedCount,
          failedCount: result.failedCount,
        };
      } catch (failure) {
        return {
          error: displayError(failure),
          revokedCount: null,
          failedCount: 0,
        };
      }
    },
    { error: null, revokedCount: null, failedCount: 0 },
  );
  return (
    <form
      action={action}
      className="fog-ai-connections"
      aria-label="AI クライアント接続"
    >
      <p className="fog-meta">
        心当たりの無い接続を疑う場合は、すべて失効させてください。前回のリセットより前の接続も対象です。
      </p>
      <button type="submit" className="fog-secondary" disabled={pending}>
        {pending ? "失効中…" : "すべて失効"}
      </button>
      {state.revokedCount !== null && state.error === null && !pending && (
        <p className="fog-notice" role="status">
          失効しました（{state.revokedCount} 件）
          {state.failedCount > 0 &&
            `。${state.failedCount} 件は競合のため失効できませんでした。もう一度お試しください`}
        </p>
      )}
      {state.error !== null && (
        <p className="fog-error" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
