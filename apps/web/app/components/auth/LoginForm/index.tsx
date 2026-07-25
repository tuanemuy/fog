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
import { toAuthErrorDisplay } from "../errorField";
import { AUTH_FIELD_MAX_LENGTH } from "../schema";
import { loginFn } from "./action";

// React 19 resets a `<form action={fn}>` before the action runs, whatever the
// outcome. Carrying the submitted address in the state and feeding it back as
// `defaultValue` is what the reset lands on, so a failed attempt no longer
// makes the user retype it. The password is deliberately not carried back.
type FormState = { error: SerializedError | null; email: string };
const initialState: FormState = { error: null, email: "" };

export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const login = useServerFn(loginFn);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    async (_prev, formData) => {
      const email = String(formData.get("email") ?? "");
      try {
        await login({
          data: { email, password: String(formData.get("password") ?? "") },
        });
        await router.invalidate();
        await router.navigate({ href: redirectTo });
        return initialState;
      } catch (error) {
        return { error: extractSerializedError(error), email };
      }
    },
    initialState,
  );

  const display = toAuthErrorDisplay(state.error);

  // Failure leaves focus on the submit button, where nothing describes what
  // went wrong. Moving it to the offending field reads label, invalid state
  // and message in one go.
  useEffect(() => {
    const target = toAuthErrorDisplay(state.error);
    if (target.email !== undefined) emailRef.current?.focus();
    else if (target.password !== undefined) passwordRef.current?.focus();
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-lg">
      {display.form !== undefined ? (
        <FormMessage>{display.form}</FormMessage>
      ) : null}

      <TextField
        id="login-email"
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

      <TextField
        id="login-password"
        name="password"
        label="パスワード"
        type="password"
        autoComplete="current-password"
        placeholder="パスワード"
        maxLength={AUTH_FIELD_MAX_LENGTH}
        inputRef={passwordRef}
        required
        {...(display.password !== undefined ? { error: display.password } : {})}
      />

      <Button
        type="submit"
        fullWidth
        pending={isPending}
        pendingLabel="ログイン中…"
      >
        ログイン
      </Button>

      <div className="mt-section flex flex-col gap-sm text-center text-sm text-neutral-600">
        <TextLink to="/signup">アカウント登録</TextLink>
        <TextLink to="/password-reset">パスワードを忘れた</TextLink>
      </div>
    </form>
  );
}
