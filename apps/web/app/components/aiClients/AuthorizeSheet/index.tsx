"use client";

import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId } from "react";
import { BrandLockup } from "@/components/layout/BrandLockup";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import {
  approveAiClientAuthorizationFn,
  denyAiClientAuthorizationFn,
} from "../actions";
import {
  type AuthorizationRequestView,
  isAuthorizationOutcome,
} from "../schema";

export const ALLOWED_OPERATIONS = [
  "メモを読む・書く",
  "ドキュメントを読む・書く",
  "トピックを作る・更新する（完了を含む）",
  "ゴミ箱へ移す（ソフトデリート）",
] as const;

export const DENIED_OPERATIONS = [
  "完全削除・履歴の削除はできません",
  "ゴミ箱にアクセス・復元・空にすることはできません",
  "履歴の閲覧・ロールバックはできません",
] as const;

export const INVALID_REQUEST_MESSAGE =
  "認可リクエストが正しくありません。クライアントアプリからやり直してください";

/**
 * P-14. The two decisions run as actions; either ends in a full navigation
 * to the client's own redirect URI, so no route context survives. An
 * invalid or expired request draws the error and no 「許可する」 at all.
 */
export function AuthorizeSheet({
  request,
  view,
}: {
  request: string | undefined;
  view: AuthorizationRequestView;
}) {
  const approve = useServerFn(approveAiClientAuthorizationFn);
  const deny = useServerFn(denyAiClientAuthorizationFn);
  const id = useId();
  const [error, act, pending] = useActionState<string | null, FormData>(
    async (_previous, formData) => {
      if (request === undefined) return INVALID_REQUEST_MESSAGE;
      const decision = formData.get("decision");
      try {
        const outcome = readServerFnResult(
          await (decision === "approve" ? approve : deny)({
            data: { request },
          }),
          isAuthorizationOutcome,
          decision === "approve"
            ? "approveAiClientAuthorizationFn"
            : "denyAiClientAuthorizationFn",
        );
        window.location.assign(outcome.redirectTo);
        return null;
      } catch (failure) {
        return displayError(failure);
      }
    },
    null,
  );

  return (
    <main className="fog-auth">
      <section className="fog-auth-sheet" aria-labelledby={`${id}-title`}>
        <div className="fog-auth-brand">
          <BrandLockup />
        </div>
        <h1 id={`${id}-title`}>アクセス許可</h1>
        {view.ok ? (
          <>
            <p className="fog-auth-description">
              <strong>{view.clientName}</strong> が、
              <strong>{view.email}</strong> として接続することを求めています。
            </p>
            <section
              aria-labelledby={`${id}-allowed`}
              className="fog-authorize-list"
            >
              <h2 id={`${id}-allowed`}>許可される操作</h2>
              <ul>
                {ALLOWED_OPERATIONS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
            <section
              aria-labelledby={`${id}-denied`}
              className="fog-authorize-list"
            >
              <h2 id={`${id}-denied`}>できないこと</h2>
              <ul>
                {DENIED_OPERATIONS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
            <form
              className="fog-auth-form fog-authorize-actions"
              action={act}
              aria-busy={pending}
              aria-label="アクセス許可の決定"
            >
              {error && (
                <p className="fog-error" role="alert">
                  {error}
                </p>
              )}
              <button
                type="submit"
                name="decision"
                value="approve"
                className="fog-primary"
                disabled={pending}
              >
                {pending ? "処理中…" : "許可する"}
              </button>
              <button
                type="submit"
                name="decision"
                value="deny"
                className="fog-secondary"
                disabled={pending}
              >
                拒否する
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="fog-error" role="alert">
              {INVALID_REQUEST_MESSAGE}
            </p>
            <p className="fog-auth-footer">
              <Link to="/">タイムラインへ</Link>
            </p>
          </>
        )}
      </section>
    </main>
  );
}
