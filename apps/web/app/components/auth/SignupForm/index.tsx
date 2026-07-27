"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";
import { TextField } from "@/components/ui/TextField";
import { TextLink } from "@/components/ui/TextLink";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";
import { DEFAULT_REDIRECT_PATH } from "@/presentation/redirectSearch";
import { toAuthErrorDisplay } from "../errorField";
import { AUTH_FIELD_MAX_LENGTH } from "../schema";
import { signupFn } from "./action";

// React 19 resets a `<form action={fn}>` before the action runs, whatever the
// outcome. Carrying the submitted address in the state and feeding it back as
// `defaultValue` is what the reset lands on, so "already registered" no longer
// costs the user their typing. The password is deliberately not carried back.
type FormState = { error: SerializedError | null; email: string };
const initialState: FormState = { error: null, email: "" };

export function SignupForm() {
  const router = useRouter();
  const signup = useServerFn(signupFn);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const formMessageRef = useRef<HTMLParagraphElement>(null);
  const operationIdRef = useRef(crypto.randomUUID());

  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    async (_prev, formData) => {
      const email = String(formData.get("email") ?? "");
      try {
        await signup({
          data: {
            operationId: operationIdRef.current,
            email,
            password: String(formData.get("password") ?? ""),
          },
        });
        await router.invalidate();
        await router.navigate({ to: DEFAULT_REDIRECT_PATH });
        return initialState;
      } catch (error) {
        return { error: extractSerializedError(error), email };
      }
    },
    initialState,
  );

  const display = toAuthErrorDisplay(state.error);

  // The submit button is disabled while the request is in flight, so a
  // failure drops focus to `<body>`. Move it to the offending field (label,
  // invalid state and message in one go); a form-level failure names no
  // field, so the banner takes the focus.
  useEffect(() => {
    const target = toAuthErrorDisplay(state.error);
    if (target.email !== undefined) emailRef.current?.focus();
    else if (target.password !== undefined) passwordRef.current?.focus();
    else if (target.form !== undefined) formMessageRef.current?.focus();
  }, [state]);

  return (
    <>
      {/* 設計の `.auth-form` から margin-top だけ意図的に落としている。
          本文の上余白は AuthSheet 側のラッパーが持つ */}
      <form action={formAction} className="flex flex-col gap-lg">
        {display.form !== undefined ? (
          <FormMessage ref={formMessageRef}>{display.form}</FormMessage>
        ) : null}

        <TextField
          id="signup-email"
          name="email"
          label="メールアドレス"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          maxLength={AUTH_FIELD_MAX_LENGTH}
          defaultValue={state.email}
          inputRef={emailRef}
          required
          {...(display.email !== undefined ? { error: display.email } : {})}
        />

        {display.showLoginLink ? (
          <p className="text-sm">
            <TextLink to="/login">このメールアドレスでログインする</TextLink>
          </p>
        ) : null}

        <TextField
          id="signup-password"
          name="password"
          label="パスワード"
          type="password"
          autoComplete="new-password"
          placeholder="パスワード"
          helperText="8文字以上128文字以下"
          maxLength={AUTH_FIELD_MAX_LENGTH}
          inputRef={passwordRef}
          required
          {...(display.password !== undefined
            ? { error: display.password }
            : {})}
        />

        <Button
          type="submit"
          fullWidth
          pending={isPending}
          pendingLabel="登録中…"
        >
          登録する
        </Button>
      </form>

      {/* モックでは `.form-links` が `<form>` の兄弟。中に入れると flex の
          gap-lg (24px) と mt-section (36px) を二重取りしてカード外周の
          余白 (40px) を超える */}
      <div className="mt-section flex flex-col gap-sm text-center text-sm text-neutral-600">
        <TextLink to="/login">ログイン</TextLink>
      </div>
    </>
  );
}
