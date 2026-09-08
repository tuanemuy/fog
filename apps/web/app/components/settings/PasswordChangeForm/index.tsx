"use client";

import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId, useState } from "react";
import { displayError, toDisplayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { changePasswordFn } from "../actions";
import { isPasswordChangedResult } from "../schema";

export type PasswordChangeState = Readonly<{
  currentError: string | null;
  newError: string | null;
  formError: string | null;
  changed: boolean;
}>;

const INITIAL: PasswordChangeState = {
  currentError: null,
  newError: null,
  formError: null,
  changed: false,
};

export function classifyPasswordChangeError(
  failure: unknown,
): PasswordChangeState {
  const serialized = toDisplayError(failure);
  const message = displayError(failure);
  if (
    serialized.kind === "validation" &&
    serialized.code === "CURRENT_PASSWORD_MISMATCH"
  ) {
    return { ...INITIAL, currentError: message };
  }
  if (
    serialized.kind === "business" &&
    serialized.code === "PASSWORD_TOO_WEAK"
  ) {
    return { ...INITIAL, newError: message };
  }
  return { ...INITIAL, formError: message };
}

/**
 * P-13's password change (S-AC-07, logged in). Shown only for an account
 * whose email credential is usable for login. The session is re-issued by
 * the server function, so the user continues without logging in again.
 */
export function PasswordChangeForm() {
  const change = useServerFn(changePasswordFn);
  const id = useId();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [state, action, pending] = useActionState<
    PasswordChangeState,
    FormData
  >(async () => {
    try {
      readServerFnResult(
        await change({ data: { currentPassword, newPassword } }),
        isPasswordChangedResult,
        "changePasswordFn",
      );
    } catch (failure) {
      return classifyPasswordChangeError(failure);
    }
    setCurrentPassword("");
    setNewPassword("");
    return { ...INITIAL, changed: true };
  }, INITIAL);
  return (
    <form
      action={action}
      className="fog-password-change"
      aria-label="パスワードの変更"
      aria-busy={pending}
    >
      <label htmlFor={`${id}-current`}>現在のパスワード</label>
      <input
        id={`${id}-current`}
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        maxLength={128}
        required
        value={currentPassword}
        onChange={(event) => setCurrentPassword(event.target.value)}
        disabled={pending}
        aria-invalid={state.currentError ? true : undefined}
      />
      {state.currentError && (
        <p className="fog-error" role="alert">
          {state.currentError}
        </p>
      )}
      <label htmlFor={`${id}-new`}>新しいパスワード</label>
      <input
        id={`${id}-new`}
        name="newPassword"
        type="password"
        autoComplete="new-password"
        maxLength={128}
        required
        value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)}
        disabled={pending}
        aria-invalid={state.newError ? true : undefined}
      />
      {state.newError ? (
        <p className="fog-error" role="alert">
          {state.newError}
        </p>
      ) : (
        <p className="fog-hint">8文字以上128文字以下で設定してください。</p>
      )}
      {state.formError && (
        <p className="fog-error" role="alert">
          {state.formError}
        </p>
      )}
      {state.changed && !pending && (
        <p className="fog-notice" role="status">
          変更しました
        </p>
      )}
      <button type="submit" className="fog-primary" disabled={pending}>
        {pending ? "変更中…" : "パスワードを変更"}
      </button>
    </form>
  );
}
