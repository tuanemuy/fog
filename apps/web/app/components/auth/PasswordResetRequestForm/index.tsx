"use client";

import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId, useState } from "react";
import { AuthSheetTitle } from "@/components/layout/AuthSheet";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { requestPasswordResetFn } from "../actions";
import { isResetRequestedResult } from "../schema";

/**
 * P-03, the request half. Every outcome ends on the same `?sent=1`
 * screen: the server answers the same for a registered address, an
 * unknown one and an SSO-only account (S-AC-07).
 */
export function PasswordResetRequestForm({ sent }: { sent: boolean }) {
  const request = useServerFn(requestPasswordResetFn);
  const navigate = useNavigate();
  const id = useId();
  const [email, setEmail] = useState("");
  const [error, action, pending] = useActionState<string | null, FormData>(
    async () => {
      try {
        readServerFnResult(
          await request({ data: { email } }),
          isResetRequestedResult,
          "requestPasswordResetFn",
        );
      } catch (failure) {
        return displayError(failure);
      }
      await navigate({ to: "/password-reset", search: { sent: 1 } });
      return null;
    },
    null,
  );
  return (
    <section aria-labelledby={`${id}-title`}>
      <AuthSheetTitle id={`${id}-title`}>パスワードをリセット</AuthSheetTitle>
      {sent ? (
        <>
          <p className="fog-notice" role="status">
            登録されていれば、リセット用のメールを送信しました。メールのリンクから続けてください。
          </p>
          <p className="fog-auth-footer">
            <Link to="/login">ログインへ戻る</Link>
          </p>
        </>
      ) : (
        <>
          <p className="fog-auth-description">
            登録したメールアドレスを入力してください。リセット用のリンクを送ります。
          </p>
          <form
            className="fog-auth-form"
            action={action}
            aria-busy={pending}
            aria-label="パスワードリセットの依頼"
          >
            <label htmlFor={`${id}-email`}>メールアドレス</label>
            <input
              id={`${id}-email`}
              name="email"
              type="email"
              autoComplete="email"
              maxLength={320}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={pending}
            />
            {error && (
              <p className="fog-error" role="alert">
                {error}
              </p>
            )}
            <button className="fog-primary" type="submit" disabled={pending}>
              {pending ? "送信中…" : "リセット用メールを送る"}
            </button>
          </form>
          <p className="fog-auth-footer">
            <Link to="/login">ログインへ戻る</Link>
          </p>
        </>
      )}
    </section>
  );
}
