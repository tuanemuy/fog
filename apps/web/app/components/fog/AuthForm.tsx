"use client";

import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useState } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { extractSerializedError } from "@/presentation/errorResponse";
import { loginFog, registerFog } from "@/presentation/fogActions";
import { safeReturnTo } from "@/presentation/fogSecurity";
import { AccountNotice } from "./AccountNotice";
import { Brand } from "./Brand";
import { GoogleButton } from "./GoogleButton";

export function AuthForm({
  mode,
  returnTo,
  googleEnabled,
  status,
}: {
  mode: "login" | "signup";
  returnTo: string;
  googleEnabled: boolean;
  status: string | undefined;
}) {
  const signup = mode === "signup";
  const login = useServerFn(loginFog);
  const register = useServerFn(registerFog);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, action, pending] = useActionState<string | null, FormData>(
    async () => {
      try {
        await (signup ? register : login)({ data: { email, password } });
        window.location.assign(safeReturnTo(returnTo));
        return null;
      } catch (failure) {
        const serialized = extractSerializedError(failure);
        if (serialized.code === "INVALID_CREDENTIALS")
          return "メールアドレスまたはパスワードが正しくありません。";
        if (serialized.code === "EMAIL_EXISTS")
          return "このメールアドレスは登録済みです。下のリンクからログインしてください。";
        return displayError(failure);
      }
    },
    null,
  );
  return (
    <main className="fog-auth">
      <section className="fog-auth-sheet" aria-labelledby="auth-title">
        <div className="fog-auth-brand">
          <Brand />
        </div>
        <h1 id="auth-title">{signup ? "アカウント登録" : "ログイン"}</h1>
        <p className="fog-auth-description">
          {signup
            ? "思いついたことを、気軽に残そう。"
            : "あなたのメモが待っています。"}
        </p>
        <AccountNotice status={status} />
        {googleEnabled && <GoogleButton returnTo={returnTo} />}
        <form className="fog-auth-form" action={action} aria-busy={pending}>
          <label htmlFor="email">メールアドレス</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            maxLength={254}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={pending}
          />
          <label htmlFor="password">パスワード</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={signup ? "new-password" : "current-password"}
            maxLength={128}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
            aria-describedby={
              error ? "auth-error" : signup ? "password-hint" : undefined
            }
          />
          {signup && (
            <p id="password-hint" className="fog-hint">
              12文字以上で設定してください。
            </p>
          )}
          {error && (
            <p id="auth-error" className="fog-error" role="alert">
              {error}
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
        {!signup && (
          <p>
            <Link to="/password/forgot">パスワードを忘れた方</Link>
          </p>
        )}
        <p className="fog-auth-footer">
          {signup ? "アカウントをお持ちの方は" : "はじめての方は"}{" "}
          <Link to={signup ? "/login" : "/signup"} search={{ returnTo }}>
            {signup ? "ログイン" : "アカウント登録"}
          </Link>
        </p>
      </section>
    </main>
  );
}
