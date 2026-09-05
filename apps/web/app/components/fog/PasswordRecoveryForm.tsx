"use client";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { extractSerializedError } from "@/presentation/errorResponse";
import {
  completeFogPasswordReset,
  requestFogPasswordReset,
} from "@/presentation/fogAccountActions";
import { Brand } from "./Brand";
export function PasswordRecoveryForm({ token }: { token?: string }) {
  const reset = token !== undefined;
  const request = useServerFn(requestFogPasswordReset);
  const complete = useServerFn(completeFogPasswordReset);
  const [state, action, pending] = useActionState<
    { error: string | null; message: string },
    FormData
  >(
    async (_, form) => {
      try {
        if (reset) {
          await complete({
            data: { token, newPassword: String(form.get("password") ?? "") },
          });
          window.location.replace("/password/reset-complete");
          return {
            error: null,
            message: "再設定しました。ログイン手段を確認しています…",
          };
        }
        const result = await request({
          data: { email: String(form.get("email") ?? "") },
        });
        return { error: null, message: result.message };
      } catch (failure) {
        return {
          error:
            extractSerializedError(failure).code === "INVALID_RESET_TOKEN"
              ? "この再設定リンクは無効か、有効期限が切れています。メールを再送してください。"
              : displayError(failure),
          message: "",
        };
      }
    },
    { error: null, message: "" },
  );
  return (
    <main className="fog-auth">
      <section className="fog-auth-sheet">
        <Brand />
        <h1>{reset ? "パスワードの再設定" : "パスワードを忘れた方"}</h1>
        <p>
          {reset
            ? "新しいパスワードを設定します。既存のログインはすべて終了します。"
            : "登録したメールアドレスに再設定の案内を送ります。"}
        </p>
        <form action={action} className="fog-auth-form" aria-busy={pending}>
          {reset ? (
            <>
              <label htmlFor="recovery-password">新しいパスワード</label>
              <input
                id="recovery-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                disabled={pending}
              />
              <p className="fog-hint">12文字以上で設定してください。</p>
            </>
          ) : (
            <>
              <label htmlFor="recovery-email">メールアドレス</label>
              <input
                id="recovery-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                disabled={pending}
              />
            </>
          )}
          {state.error && (
            <p className="fog-error" role="alert">
              {state.error}
            </p>
          )}
          <button type="submit" className="fog-primary" disabled={pending}>
            {pending
              ? "処理中…"
              : reset
                ? "パスワードを再設定"
                : "再設定メールを送信"}
          </button>
          <p role="status">{state.message}</p>
        </form>
        {reset && (
          <p>
            <Link to="/password/forgot">期限が切れた場合はメールを再送</Link>
          </p>
        )}
        <p>
          <Link to="/login" search={{ returnTo: "/timeline" }}>
            ログインへ戻る
          </Link>
        </p>
      </section>
    </main>
  );
}
