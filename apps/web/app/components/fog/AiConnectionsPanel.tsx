"use client";
import type { AiConnectionView } from "@repo/core/application/fog/aiTypes";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { revokeAllFogAiConnections } from "@/presentation/fogAccountActions";
import { revokeFogAiConnection } from "@/presentation/fogAiActions";
import { ConfirmDialog } from "./ConfirmDialog";

const date = (value: string) =>
  new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
export function AiConnectionsPanel({
  connections,
}: {
  connections: AiConnectionView[];
}) {
  const router = useRouter();
  const revokeAll = useServerFn(revokeAllFogAiConnections);
  const [all, setAll] = useState(false);
  const revoke = useServerFn(revokeFogAiConnection);
  const [items, remove] = useOptimistic(connections, (current, id: string) =>
    id === "all" ? [] : current.filter((item) => item.id !== id),
  );
  const [target, setTarget] = useState<AiConnectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <section
      className="fog-settings-section"
      aria-label="接続済みAIクライアント"
      aria-busy={pending}
    >
      <h3>接続済みAIクライアント</h3>
      {items.length ? (
        items.map((item) => (
          <article className="fog-ai-connection" key={item.id}>
            <h4>{item.clientName}</h4>
            <p className="fog-meta">
              接続 {date(item.createdAt)}
              <br />
              最終利用{" "}
              {item.lastUsedAt
                ? date(item.lastUsedAt)
                : "まだ利用されていません"}
            </p>
            <button
              type="button"
              className="fog-text-button fog-danger"
              disabled={pending}
              onClick={() => {
                setError(null);
                setTarget(item);
              }}
            >
              接続を解除
            </button>
          </article>
        ))
      ) : (
        <p className="fog-hint">
          接続済みのAIクライアントはありません。LLMアプリでfogを追加し、ブラウザに表示される操作一覧を確認して接続してください。
        </p>
      )}
      <button
        type="button"
        className="fog-secondary"
        disabled={pending}
        onClick={() => {
          setError(null);
          setAll(true);
        }}
      >
        AI接続をすべて解除
      </button>
      {all && (
        <ConfirmDialog
          title="すべてのAI接続を解除しますか？"
          pending={pending}
          onCancel={() => setAll(false)}
        >
          <p>すべての接続と認可途中の要求を失効します。</p>
          {error && (
            <p role="alert" className="fog-error">
              {error}
            </p>
          )}
          <button
            type="button"
            className="fog-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                remove("all");
                try {
                  await revokeAll({ data: {} });
                  await router.invalidate();
                  setAll(false);
                } catch (failure) {
                  setError(displayError(failure));
                }
              })
            }
          >
            {pending ? "解除中…" : "すべて解除する"}
          </button>
        </ConfirmDialog>
      )}
      {target && (
        <ConfirmDialog
          title="AIクライアントの接続を解除しますか？"
          pending={pending}
          onCancel={() => setTarget(null)}
        >
          <p>
            「{target.clientName}
            」からの読み書きは、解除後すぐに利用できなくなります。再び使う場合は接続をやり直してください。
          </p>
          {error && (
            <p className="fog-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="fog-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                remove(target.id);
                try {
                  await revoke({ data: { id: target.id } });
                  await router.invalidate();
                  setTarget(null);
                } catch (failure) {
                  setError(displayError(failure));
                }
              })
            }
          >
            {pending ? "解除中…" : "接続を解除する"}
          </button>
        </ConfirmDialog>
      )}
    </section>
  );
}
