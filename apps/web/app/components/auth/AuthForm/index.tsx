"use client";

import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId, useState } from "react";
import { AuthSheetTitle } from "@/components/layout/AuthSheet";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { FormLink } from "@/components/ui/FormLink";
import { TextField } from "@/components/ui/TextField";
import { displayError, renderErrorMessage } from "@/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";
import { DEFAULT_REDIRECT_PATH } from "@/presentation/redirectSearch";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { loginFn, registerFn } from "../actions";
import { renderSsoError, SsoButtons } from "../SsoButtons";
import { isSessionStartedResult, type SsoErrorCode } from "../schema";

type Field = "email" | "password";

export type AuthFormState = Readonly<{
  fieldErrors: Partial<Record<Field, string>>;
  formError: string | null;
  duplicate: boolean;
}>;

const INITIAL_STATE: AuthFormState = {
  fieldErrors: {},
  formError: null,
  duplicate: false,
};

/**
 * Which field a failure belongs to. Only the registration form attributes
 * errors to fields: the login form deliberately shows one message for every
 * failure (S-AC-03).
 */
export function classifyAuthError(
  serialized: SerializedError,
  mode: "login" | "signup",
): AuthFormState {
  if (mode === "signup") {
    if (serialized.kind === "business") {
      if (serialized.code === "INVALID_EMAIL") {
        return {
          ...INITIAL_STATE,
          fieldErrors: { email: renderErrorMessage(serialized) },
        };
      }
      if (serialized.code === "PASSWORD_TOO_WEAK") {
        return {
          ...INITIAL_STATE,
          fieldErrors: { password: renderErrorMessage(serialized) },
        };
      }
    }
    if (
      serialized.kind === "conflict" &&
      serialized.code === "EMAIL_ALREADY_REGISTERED"
    ) {
      return {
        ...INITIAL_STATE,
        formError: "このメールアドレスは既に登録されています。",
        duplicate: true,
      };
    }
  }
  return { ...INITIAL_STATE, formError: renderErrorMessage(serialized) };
}

/**
 * P-01 / P-02 on the auth sheet (`spec/design/pages/login.html` /
 * `signup.html`): the title, the form with its failure at the head, the SSO
 * providers under 「または」, and the entries to the other screens.
 */
export function AuthForm({
  mode,
  redirectTo,
  ssoError,
  ssoProviders,
}: {
  mode: "login" | "signup";
  redirectTo: string | undefined;
  ssoError?: SsoErrorCode | undefined;
  ssoProviders: readonly string[];
}) {
  const signup = mode === "signup";
  const login = useServerFn(loginFn);
  const register = useServerFn(registerFn);
  const id = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const target = redirectTo ?? DEFAULT_REDIRECT_PATH;
  const [state, action, pending] = useActionState<AuthFormState, FormData>(
    async () => {
      try {
        readServerFnResult(
          await (signup ? register : login)({ data: { email, password } }),
          isSessionStartedResult,
          signup ? "registerFn" : "loginFn",
        );
      } catch (failure) {
        try {
          return classifyAuthError(extractSerializedError(failure), mode);
        } catch {
          return { ...INITIAL_STATE, formError: displayError(failure) };
        }
      }
      // A full navigation, not a router transition: the session cookie now
      // exists and every cached route context has to be rebuilt from it.
      window.location.assign(target);
      return INITIAL_STATE;
    },
    INITIAL_STATE,
  );
  const redirectSearch = redirectTo ? { redirect: redirectTo } : {};
  const loginEntry = (
    <>
      {" "}
      <FormLink to="/login" search={redirectSearch}>
        ログイン
      </FormLink>
    </>
  );
  // One box at the head of the form: this attempt's failure, or else the
  // failed SSO round trip that brought the page here.
  const failure =
    state.formError !== null ? (
      <>
        {state.formError}
        {state.duplicate && loginEntry}
      </>
    ) : ssoError !== undefined ? (
      <>
        {renderSsoError(ssoError, mode)}
        {ssoError === "email_registered" && signup && loginEntry}
      </>
    ) : null;
  return (
    <section aria-labelledby={`${id}-title`}>
      <AuthSheetTitle id={`${id}-title`}>
        {signup ? "アカウント登録" : "ログイン"}
      </AuthSheetTitle>
      <form
        className="mt-section flex flex-col gap-lg"
        action={action}
        aria-busy={pending}
      >
        {failure === null ? null : <FormError>{failure}</FormError>}
        <TextField
          label="メールアドレス"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          maxLength={320}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={pending}
          error={state.fieldErrors.email}
        />
        <TextField
          label="パスワード"
          helper={signup ? "8文字以上" : undefined}
          name="password"
          type="password"
          autoComplete={signup ? "new-password" : "current-password"}
          placeholder="パスワード"
          maxLength={128}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
          error={state.fieldErrors.password}
        />
        <Button variant="fill" type="submit" disabled={pending}>
          {pending
            ? signup
              ? "登録中…"
              : "ログイン中…"
            : signup
              ? "登録する"
              : "ログイン"}
        </Button>
      </form>
      {ssoProviders.length > 0 && (
        <p
          className="mt-lg flex items-center gap-md font-base text-sm leading-tight text-neutral-600"
          aria-hidden="true"
        >
          <span className="flex-1 border-t border-neutral-100" />
          または
          <span className="flex-1 border-t border-neutral-100" />
        </p>
      )}
      <SsoButtons
        mode={mode}
        redirectTo={redirectTo}
        providers={ssoProviders}
      />
      <div className="mt-section flex flex-col items-center gap-sm font-base text-sm leading-tight">
        {signup ? (
          <FormLink to="/login" search={redirectSearch}>
            ログイン
          </FormLink>
        ) : (
          <>
            <FormLink to="/signup" search={redirectSearch}>
              アカウント登録
            </FormLink>
            <FormLink to="/password-reset">パスワードを忘れた</FormLink>
          </>
        )}
      </div>
    </section>
  );
}
