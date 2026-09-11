"use client";

import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId, useState } from "react";
import { AuthSheetTitle } from "@/components/layout/AuthSheet";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { TextField } from "@/components/ui/TextField";
import { displayError, toDisplayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { executePasswordResetFn } from "../actions";
import { FormLink } from "../FormLink";
import { isSessionStartedResult } from "../schema";

/**
 * Where a failed reset is drawn: under the password field, at the head of
 * the form, or — for a link that is spent or expired — at the head of the
 * form with the way to a new request instead of a retry.
 */
export type PasswordResetFailure =
  | Readonly<{ kind: "field"; message: string }>
  | Readonly<{ kind: "form"; message: string }>
  | Readonly<{ kind: "invalid-token" }>;

export function classifyResetError(failure: unknown): PasswordResetFailure {
  const serialized = toDisplayError(failure);
  if (
    serialized.kind === "business" &&
    serialized.code === "PASSWORD_TOO_WEAK"
  ) {
    return { kind: "field", message: displayError(failure) };
  }
  if (
    serialized.kind === "validation" &&
    serialized.code === "RESET_TOKEN_INVALID"
  ) {
    return { kind: "invalid-token" };
  }
  return { kind: "form", message: displayError(failure) };
}

/**
 * P-03, the completion half (`spec/design/pages/password-reset.html`,
 * 新パスワード再設定). The token never leaves the URL except in the request
 * body; on success the new session exists and a full navigation rebuilds
 * every route context from it.
 */
export function PasswordResetForm({ token }: { token: string }) {
  const execute = useServerFn(executePasswordResetFn);
  const id = useId();
  const [newPassword, setNewPassword] = useState("");
  const [failure, action, pending] = useActionState<
    PasswordResetFailure | null,
    FormData
  >(async () => {
    try {
      readServerFnResult(
        await execute({ data: { token, newPassword } }),
        isSessionStartedResult,
        "executePasswordResetFn",
      );
    } catch (thrown) {
      return classifyResetError(thrown);
    }
    window.location.assign("/password-reset/done");
    return null;
  }, null);
  return (
    <section aria-labelledby={`${id}-title`}>
      <AuthSheetTitle id={`${id}-title`}>パスワードリセット</AuthSheetTitle>
      <form
        className="mt-section flex flex-col gap-lg"
        action={action}
        aria-busy={pending}
        aria-label="新しいパスワードの設定"
      >
        {failure?.kind === "invalid-token" ? (
          // A spent link and an expired one read the same (S-AC-07).
          <FormError>
            リセットリンクが無効か、有効期限が切れています。もう一度
            <FormLink to="/password-reset">パスワードリセット</FormLink>
            をお試しください
          </FormError>
        ) : failure?.kind === "form" ? (
          <FormError>{failure.message}</FormError>
        ) : null}
        <TextField
          label="新パスワード"
          helper="8文字以上"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          placeholder="新しいパスワード"
          maxLength={128}
          required
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          disabled={pending}
          error={failure?.kind === "field" ? failure.message : undefined}
        />
        <Button variant="fill" type="submit" disabled={pending}>
          {pending ? "更新中…" : "パスワードを更新"}
        </Button>
      </form>
    </section>
  );
}
