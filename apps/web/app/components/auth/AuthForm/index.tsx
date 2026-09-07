"use client";

import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId, useState } from "react";
import { Brand } from "@/components/layout/Brand";
import { displayError, renderErrorMessage } from "@/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";
import { DEFAULT_REDIRECT_PATH } from "@/presentation/redirectSearch";
import { loginFn, registerFn } from "../actions";

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
        formError: "このメールアドレスは既に登録されています",
        duplicate: true,
      };
    }
  }
  return { ...INITIAL_STATE, formError: renderErrorMessage(serialized) };
}

export function AuthForm({
  mode,
  redirectTo,
}: {
  mode: "login" | "signup";
  redirectTo: string | undefined;
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
        await (signup ? register : login)({ data: { email, password } });
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
  const emailError = state.fieldErrors.email;
  const passwordError = state.fieldErrors.password;
  return (
    <main className="fog-auth">
      <section className="fog-auth-sheet" aria-labelledby={`${id}-title`}>
        <div className="fog-auth-brand">
          <Brand />
        </div>
        <h1 id={`${id}-title`}>{signup ? "アカウント登録" : "ログイン"}</h1>
        <p className="fog-auth-description">
          {signup
            ? "思いついたことを、気軽に残そう。"
            : "あなたのメモが待っています。"}
        </p>
        <form className="fog-auth-form" action={action} aria-busy={pending}>
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
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? `${id}-email-error` : undefined}
          />
          {emailError && (
            <p id={`${id}-email-error`} className="fog-error" role="alert">
              {emailError}
            </p>
          )}
          <label htmlFor={`${id}-password`}>パスワード</label>
          <input
            id={`${id}-password`}
            name="password"
            type="password"
            autoComplete={signup ? "new-password" : "current-password"}
            maxLength={128}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={
              passwordError
                ? `${id}-password-error`
                : signup
                  ? `${id}-password-hint`
                  : undefined
            }
          />
          {signup && !passwordError && (
            <p id={`${id}-password-hint`} className="fog-hint">
              8文字以上128文字以下で設定してください。
            </p>
          )}
          {passwordError && (
            <p id={`${id}-password-error`} className="fog-error" role="alert">
              {passwordError}
            </p>
          )}
          {state.formError && (
            <p className="fog-error" role="alert">
              {state.formError}
              {state.duplicate && (
                <>
                  {" "}
                  <Link
                    to="/login"
                    search={redirectTo ? { redirect: redirectTo } : {}}
                  >
                    ログインする
                  </Link>
                </>
              )}
            </p>
          )}
          <button className="fog-primary" type="submit" disabled={pending}>
            {pending
              ? signup
                ? "登録中…"
                : "ログイン中…"
              : signup
                ? "アカウント登録"
                : "ログイン"}
          </button>
        </form>
        <p className="fog-auth-footer">
          {signup ? "アカウントをお持ちの方は" : "はじめての方は"}{" "}
          {signup ? (
            <Link
              to="/login"
              search={redirectTo ? { redirect: redirectTo } : {}}
            >
              ログイン
            </Link>
          ) : (
            <Link
              to="/signup"
              search={redirectTo ? { redirect: redirectTo } : {}}
            >
              アカウント登録
            </Link>
          )}
        </p>
      </section>
    </main>
  );
}
