"use client";

import type { CredentialView } from "@repo/core/application/identity/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { unlinkSsoCredentialFn } from "../actions";
import { isCredentialUnlinkedResult } from "../schema";

const KIND_LABELS = { email: "メールアドレス", sso: "外部アカウント" } as const;

export function credentialLabel(credential: CredentialView): string {
  if (credential.kind === "sso") {
    return `${KIND_LABELS.sso}（${credential.label}）`;
  }
  return KIND_LABELS.email;
}

/** `/auth/sso/:provider/start?intent=link` — the only entry that creates something P-03 can unlink. */
export const LINK_GOOGLE_HREF = "/auth/sso/google/start?intent=link";

/**
 * The login methods (P-13 / P-03), owned as a list because unlinking is a
 * membership change: the row leaves optimistically, the server function
 * runs here, and a rejection puts the row back with its reason. Never
 * shows a verifier or a provider subject: the view has none.
 */
export function CredentialList({
  credentials,
  showAddLink,
}: {
  credentials: readonly CredentialView[];
  showAddLink: boolean;
}) {
  const router = useRouter();
  const unlink = useServerFn(unlinkSsoCredentialFn);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [shown, remove] = useOptimistic<readonly CredentialView[], string>(
    credentials,
    (current, credentialId) =>
      current.filter((c) => c.credentialId !== credentialId),
  );
  const onUnlink = (credentialId: string) => {
    setError(null);
    startTransition(async () => {
      remove(credentialId);
      try {
        readServerFnResult(
          await unlink({ data: { credentialId } }),
          isCredentialUnlinkedResult,
          "unlinkSsoCredentialFn",
        );
        await router.invalidate();
      } catch (failure) {
        setError(displayError(failure));
      }
    });
  };
  return (
    <div className="fog-credential-list">
      <ul className="fog-settings-list">
        {shown.map((credential) => (
          <li key={credential.credentialId} className="fog-settings-row">
            <span>{credentialLabel(credential)}</span>
            <span className="fog-meta">
              {credential.usableForLogin
                ? "ログインに使用"
                : "一意性の予約のみ"}
            </span>
            {credential.kind === "sso" && (
              <button
                type="button"
                className="fog-text-button"
                onClick={() => onUnlink(credential.credentialId)}
                aria-label={`${credentialLabel(credential)}を解除`}
              >
                解除
              </button>
            )}
          </li>
        ))}
      </ul>
      {error !== null && (
        <p className="fog-error" role="alert">
          {error}
        </p>
      )}
      {showAddLink && (
        <p>
          <a className="fog-secondary" href={LINK_GOOGLE_HREF}>
            SSO 連携を追加（Google）
          </a>
        </p>
      )}
    </div>
  );
}
