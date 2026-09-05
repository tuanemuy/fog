"use client";
import type { CredentialView } from "@repo/core/application/fog/accountTypes";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { unlinkFogGoogle } from "@/presentation/fogAccountActions";
import { ConfirmDialog } from "./ConfirmDialog";
import { GoogleButton } from "./GoogleButton";
export function CredentialsPanel({
  credentials,
  googleEnabled,
}: {
  credentials: CredentialView;
  googleEnabled: boolean;
}) {
  const router = useRouter();
  const unlink = useServerFn(unlinkFogGoogle);
  const [items, remove] = useOptimistic(
    credentials.google,
    (current, id: string) => current.filter((item) => item.id !== id),
  );
  const [target, setTarget] = useState<CredentialView["google"][number] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <section
      className="fog-settings-section"
      aria-label="ログイン手段"
      aria-busy={pending}
    >
      <h3>ログイン手段</h3>
      {credentials.hasPassword && (
        <p>メールアドレス・パスワード（解除できません）</p>
      )}
      {items.map((item) => (
        <article key={item.id} className="fog-ai-connection">
          <h4>{item.label}</h4>
          <p>{item.email}</p>
          <button
            type="button"
            className="fog-text-button fog-danger"
            disabled={pending || !item.removable}
            onClick={() => {
              setError(null);
              setTarget(item);
            }}
          >
            Google連携を解除
          </button>
          {!item.removable && (
            <p className="fog-hint">最後のログイン手段のため解除できません。</p>
          )}
        </article>
      ))}
      {googleEnabled && <GoogleButton link />}
      {target && (
        <ConfirmDialog
          title="Google連携を解除しますか？"
          pending={pending}
          onCancel={() => setTarget(null)}
        >
          <p>{target.email} のGoogleアカウントでログインできなくなります。</p>
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
                remove(target.id);
                try {
                  await unlink({ data: { id: target.id } });
                  await router.invalidate();
                  setTarget(null);
                } catch (failure) {
                  setError(displayError(failure));
                }
              })
            }
          >
            {pending ? "解除中…" : "Google連携を解除する"}
          </button>
        </ConfirmDialog>
      )}
    </section>
  );
}
