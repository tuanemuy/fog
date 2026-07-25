"use client";

import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";
import { TextField } from "@/components/ui/TextField";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";
import { toAuthErrorDisplay } from "../errorField";
import { AUTH_FIELD_MAX_LENGTH } from "../schema";
import { loginFn } from "./action";

type FormState = { error: SerializedError | null };
const initialState: FormState = { error: null };

export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const login = useServerFn(loginFn);

  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    async (_prev, formData) => {
      try {
        await login({
          data: {
            email: String(formData.get("email") ?? ""),
            password: String(formData.get("password") ?? ""),
          },
        });
        await router.invalidate();
        await router.navigate({ href: redirectTo });
        return initialState;
      } catch (error) {
        return { error: extractSerializedError(error) };
      }
    },
    initialState,
  );

  const display = toAuthErrorDisplay(state.error);

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
        disabled={isPending}
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
        disabled={isPending}
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
        <Link
          to="/signup"
          className="rounded-(--radius-sm) text-primary-dark transition-colors hover:text-primary-darker focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          アカウント登録
        </Link>
        <Link
          to="/password-reset"
          className="rounded-(--radius-sm) text-primary-dark transition-colors hover:text-primary-darker focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          パスワードを忘れた
        </Link>
      </div>
    </form>
  );
}
