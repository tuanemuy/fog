"use client";
import type { AiAuthorizationView } from "@repo/core/application/fog/aiTypes";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { decideFogAiConsent } from "@/presentation/fogAiActions";

const labels: Record<string, string> = {
  guidance: "操作とガイダンスの確認",
  "memos.recent": "最近のメモの取得",
  "memos.get": "メモの取得",
  "topics.list": "トピック一覧の取得",
  "topics.get": "トピックと配下内容の取得",
  "documents.get": "ドキュメントの取得",
  search: "メモ・ドキュメントの検索",
  "memos.create": "メモの投稿",
  "memos.replace": "メモの修正",
  "topics.create": "トピックの作成",
  "topics.update": "トピックの名前・説明・完了状態の変更",
  "documents.create": "ドキュメントと出典の作成",
  "documents.patch": "理由付きのドキュメント部分編集",
  "documents.rewrite": "明示的な依頼によるドキュメント全面書き直し",
  "content.delete": "メモ・ドキュメント・トピックをゴミ箱へ移動",
};
export function AiConsentPanel({
  authorization,
  requestToken,
}: {
  authorization: AiAuthorizationView;
  requestToken: string;
}) {
  const decide = useServerFn(decideFogAiConsent);
  const [pending, start] = useTransition();
  const [choice, setChoice] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = (allow: boolean) =>
    start(async () => {
      setChoice(allow);
      setError(null);
      try {
        const result = await decide({ data: { requestToken, allow } });
        window.location.assign(result.redirectUri);
      } catch (failure) {
        setError(displayError(failure));
      }
    });
  return (
    <section
      className="fog-content fog-ai-consent"
      aria-label="AIクライアントの認可"
      aria-busy={pending}
    >
      <h2>「{authorization.clientName}」を接続しますか？</h2>
      <p>
        このAIクライアントが、あなたの代理で次の操作を行えるようになります。
      </p>
      <ul>
        {authorization.operations.map((operation) => (
          <li key={operation}>{labels[operation] ?? operation}</li>
        ))}
      </ul>
      <p className="fog-hint">
        ゴミ箱の中身・リビジョン履歴の閲覧、復元、完全削除、アカウント設定は許可されません。接続は設定画面からいつでも解除できます。
      </p>
      <p className="fog-meta">
        戻り先: {new URL(authorization.redirectUri).origin}
      </p>
      {error && (
        <p className="fog-error" role="alert">
          {error}
        </p>
      )}
      <div className="fog-actions">
        <button
          type="button"
          className="fog-primary"
          disabled={pending}
          onClick={() => submit(true)}
        >
          {pending && choice ? "接続中…" : "許可する"}
        </button>
        <button
          type="button"
          className="fog-secondary"
          disabled={pending}
          onClick={() => submit(false)}
        >
          {pending && choice === false ? "戻っています…" : "拒否する"}
        </button>
      </div>
    </section>
  );
}
