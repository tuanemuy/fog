"use client";

import { useServerFn } from "@tanstack/react-start";
import { useActionState } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { revokeAllAiClientConnectionsFn } from "../actions";
import { isConnectionsRevokedResult } from "../schema";

type State = Readonly<{ error: string | null; revokedCount: number | null }>;

/**
 * The AI-connection half of P-03 / P-13 before the AI slice: no listing
 * yet, and one action — revoke everything — that is idempotent and always
 * available (design △-2).
 */
export function AiConnectionsPanel() {
  const revokeAll = useServerFn(revokeAllAiClientConnectionsFn);
  const [state, action, pending] = useActionState<State, FormData>(
    async () => {
      try {
        const result = readServerFnResult(
          await revokeAll({}),
          isConnectionsRevokedResult,
          "revokeAllAiClientConnectionsFn",
        );
        return { error: null, revokedCount: result.revokedCount };
      } catch (failure) {
        return { error: displayError(failure), revokedCount: null };
      }
    },
    { error: null, revokedCount: null },
  );
  return (
    <form
      action={action}
      className="fog-ai-connections"
      aria-label="AI クライアント接続"
    >
      <p className="fog-meta">
        接続の一覧は今後の更新で表示されます。心当たりの無い接続を疑う場合は、すべて失効させてください。
      </p>
      <button type="submit" className="fog-secondary" disabled={pending}>
        {pending ? "失効中…" : "すべて失効"}
      </button>
      {state.revokedCount !== null && state.error === null && !pending && (
        <p className="fog-notice" role="status">
          失効しました（{state.revokedCount} 件）
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
