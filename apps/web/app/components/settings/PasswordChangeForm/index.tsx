"use client";

import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { TextField } from "@/components/ui/TextField";
import { useToast } from "@/components/ui/Toast";
import { displayError, toDisplayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { changePasswordFn } from "../actions";
import { isPasswordChangedResult } from "../schema";

export type PasswordChangeState = Readonly<{
  currentError: string | null;
  newError: string | null;
  formError: string | null;
}>;

const INITIAL: PasswordChangeState = {
  currentError: null,
  newError: null,
  formError: null,
};

export const PASSWORD_CHANGED_MESSAGE = "パスワードを変更しました";

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

// `.form-link` in `spec/design/pages/settings.html`.
const FORM_LINK_CLASS =
  "rounded-sm font-base text-sm leading-tight text-primary-dark no-underline transition-colors hover:text-primary-darker focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * P-13's password change (S-AC-07, logged in). Shown only for an account
 * whose email credential is usable for login, together with the way to a
 * reset. A failure goes where it belongs — a field's under the field, the
 * rest (the attempt limit, shown here rather than hidden as on the login)
 * first in the form — and the success is a toast. The session is re-issued
 * by the server function, so the user continues without logging in again.
 */
export function PasswordChangeForm() {
  const change = useServerFn(changePasswordFn);
  const toast = useToast();
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
    toast(PASSWORD_CHANGED_MESSAGE);
    return INITIAL;
  }, INITIAL);
  return (
    <form
      action={action}
      className="flex flex-col gap-lg"
      aria-label="パスワード変更"
      aria-busy={pending}
    >
      {state.formError !== null && <FormError>{state.formError}</FormError>}
      <TextField
        label="現在のパスワード"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        maxLength={128}
        required
        value={currentPassword}
        onChange={(event) => setCurrentPassword(event.target.value)}
        readOnly={pending}
        error={state.currentError}
      />
      <TextField
        label="新しいパスワード"
        helper="8文字以上"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        maxLength={128}
        required
        value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)}
        readOnly={pending}
        error={state.newError}
      />
      <div className="flex flex-wrap items-center gap-x-lg gap-y-sm">
        <Button variant="fill-sm" type="submit" disabled={pending}>
          {pending ? "変更中…" : "パスワードを変更"}
        </Button>
        <Link to="/password-reset" className={FORM_LINK_CLASS}>
          パスワードを忘れた
        </Link>
      </div>
    </form>
  );
}
