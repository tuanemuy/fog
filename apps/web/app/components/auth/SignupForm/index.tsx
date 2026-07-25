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
import { DEFAULT_REDIRECT_PATH } from "@/presentation/redirectSearch";
import { toAuthErrorDisplay } from "../errorField";
import { AUTH_FIELD_MAX_LENGTH } from "../schema";
import { signupFn } from "./action";

type FormState = { error: SerializedError | null };
const initialState: FormState = { error: null };

export function SignupForm() {
  const router = useRouter();
  const signup = useServerFn(signupFn);

  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    async (_prev, formData) => {
      try {
        await signup({
          data: {
            email: String(formData.get("email") ?? ""),
            password: String(formData.get("password") ?? ""),
          },
        });
        await router.invalidate();
        await router.navigate({ to: DEFAULT_REDIRECT_PATH });
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
        id="signup-email"
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

      {display.showLoginLink ? (
        <p className="text-sm">
          <Link
            to="/login"
            className="rounded-(--radius-sm) text-primary-dark transition-colors hover:text-primary-darker focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            このメールアドレスでログインする
          </Link>
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
        disabled={isPending}
        required
        {...(display.password !== undefined ? { error: display.password } : {})}
      />

      <Button
        type="submit"
        fullWidth
        pending={isPending}
        pendingLabel="登録中…"
      >
        登録する
      </Button>

      <div className="mt-section flex flex-col gap-sm text-center text-sm text-neutral-600">
        <Link
          to="/login"
          className="rounded-(--radius-sm) text-primary-dark transition-colors hover:text-primary-darker focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          ログイン
        </Link>
      </div>
    </form>
  );
}
