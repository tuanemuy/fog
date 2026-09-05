"use client";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { extractSerializedError } from "@/presentation/errorResponse";
import { changeFogPassword } from "@/presentation/fogAccountActions";
export function PasswordChangeForm() {
  const change = useServerFn(changeFogPassword);
  const router = useRouter();
  const [state, action, pending] = useActionState<
    { error: string | null; saved: boolean },
    FormData
  >(
    async (_, form) => {
      try {
        await change({
          data: {
            currentPassword: String(form.get("currentPassword") ?? ""),
            newPassword: String(form.get("newPassword") ?? ""),
          },
        });
        await router.invalidate();
        return { error: null, saved: true };
      } catch (failure) {
        return {
          error:
            extractSerializedError(failure).code === "INVALID_CURRENT_PASSWORD"
              ? "現在のパスワードが正しくありません。"
              : displayError(failure),
          saved: false,
        };
      }
    },
    { error: null, saved: false },
  );
  return (
    <section className="fog-settings-section">
      <h3>パスワードの変更</h3>
      <p className="fog-hint">
        変更すると他の端末を含む既存のログインを終了し、この端末でログインし直します。
      </p>
      <form action={action} className="fog-auth-form" aria-busy={pending}>
        <label htmlFor="current-password">現在のパスワード</label>
        <input
          id="current-password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          disabled={pending}
        />
        <label htmlFor="new-password">新しいパスワード</label>
        <input
          id="new-password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          disabled={pending}
        />
        <p className="fog-hint">12文字以上で設定してください。</p>
        {state.error && (
          <p role="alert" className="fog-error">
            {state.error}
          </p>
        )}
        <button type="submit" className="fog-primary" disabled={pending}>
          {pending ? "変更中…" : "パスワードを変更"}
        </button>
        <p role="status">{state.saved ? "パスワードを変更しました。" : ""}</p>
      </form>
    </section>
  );
}
