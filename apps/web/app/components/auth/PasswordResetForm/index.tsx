"use client";

import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId, useState } from "react";
import { BrandLockup } from "@/components/layout/BrandLockup";
import { displayError, toDisplayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { executePasswordResetFn } from "../actions";
import { isSessionStartedResult } from "../schema";

export type PasswordResetFormState = Readonly<{
  fieldError: string | null;
  formError: string | null;
  /** The link is spent or expired: offer a new request instead of a retry. */
  invalidToken: boolean;
}>;

const INITIAL: PasswordResetFormState = {
  fieldError: null,
  formError: null,
  invalidToken: false,
};

export function classifyResetError(failure: unknown): PasswordResetFormState {
  const serialized = toDisplayError(failure);
  if (
    serialized.kind === "business" &&
    serialized.code === "PASSWORD_TOO_WEAK"
  ) {
    return { ...INITIAL, fieldError: displayError(failure) };
  }
  if (
    serialized.kind === "validation" &&
    serialized.code === "RESET_TOKEN_INVALID"
  ) {
    return { ...INITIAL, formError: displayError(failure), invalidToken: true };
  }
  return { ...INITIAL, formError: displayError(failure) };
}

/**
 * P-03, the completion half. The token never leaves the URL except in the
 * request body; on success the new session exists and a full navigation
 * rebuilds every route context from it.
 */
export function PasswordResetForm({ token }: { token: string }) {
  const execute = useServerFn(executePasswordResetFn);
  const id = useId();
  const [newPassword, setNewPassword] = useState("");
  const [state, action, pending] = useActionState<
    PasswordResetFormState,
    FormData
  >(async () => {
    try {
      readServerFnResult(
        await execute({ data: { token, newPassword } }),
        isSessionStartedResult,
        "executePasswordResetFn",
      );
    } catch (failure) {
      return classifyResetError(failure);
    }
    window.location.assign("/password-reset/done");
    return INITIAL;
  }, INITIAL);
  return (
    <main className="fog-auth">
      <section className="fog-auth-sheet" aria-labelledby={`${id}-title`}>
        <div className="fog-auth-brand">
          <BrandLockup />
        </div>
        <h1 id={`${id}-title`}>新しいパスワードを設定</h1>
        <form
          className="fog-auth-form"
          action={action}
          aria-busy={pending}
          aria-label="新しいパスワードの設定"
        >
          <label htmlFor={`${id}-password`}>新しいパスワード</label>
          <input
            id={`${id}-password`}
            name="newPassword"
            type="password"
            autoComplete="new-password"
            maxLength={128}
            required
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            disabled={pending}
            aria-invalid={state.fieldError ? true : undefined}
            aria-describedby={
              state.fieldError ? `${id}-password-error` : `${id}-password-hint`
            }
          />
          {state.fieldError ? (
            <p id={`${id}-password-error`} className="fog-error" role="alert">
              {state.fieldError}
            </p>
          ) : (
            <p id={`${id}-password-hint`} className="fog-hint">
              8文字以上128文字以下で設定してください。
            </p>
          )}
          {state.formError && (
            <p className="fog-error" role="alert">
              {state.formError}
              {state.invalidToken && (
                <>
                  {" "}
                  <Link to="/password-reset">もう一度依頼する</Link>
                </>
              )}
            </p>
          )}
          <button className="fog-primary" type="submit" disabled={pending}>
            {pending ? "設定中…" : "パスワードを設定"}
          </button>
        </form>
      </section>
    </main>
  );
}
