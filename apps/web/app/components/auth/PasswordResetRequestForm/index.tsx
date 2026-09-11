"use client";

import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId, useState } from "react";
import {
  AuthSheetDescription,
  AuthSheetTitle,
} from "@/components/layout/AuthSheet";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { TextField } from "@/components/ui/TextField";
import { useToast } from "@/components/ui/Toast";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { requestPasswordResetFn } from "../actions";
import { isResetRequestedResult } from "../schema";

export const RESET_REQUESTED_MESSAGE = "リセットメールの送信を受け付けました";

/**
 * P-03, the request half (`spec/design/pages/password-reset.html`). Every
 * outcome ends in the same toast on the same form: the server answers the
 * same for a registered address, an unknown one and an SSO-only account
 * (S-AC-07), and the description above the form already says the mail goes
 * only to an address that has an account.
 */
export function PasswordResetRequestForm() {
  const request = useServerFn(requestPasswordResetFn);
  const toast = useToast();
  const id = useId();
  const [email, setEmail] = useState("");
  const [error, action, pending] = useActionState<string | null, FormData>(
    async () => {
      try {
        readServerFnResult(
          await request({ data: { email } }),
          isResetRequestedResult,
          "requestPasswordResetFn",
        );
      } catch (failure) {
        return displayError(failure);
      }
      toast(RESET_REQUESTED_MESSAGE);
      return null;
    },
    null,
  );
  return (
    <section aria-labelledby={`${id}-title`}>
      <AuthSheetTitle id={`${id}-title`}>パスワードリセット</AuthSheetTitle>
      <AuthSheetDescription>
        アカウントが存在する場合、リセットリンクをお送りします
      </AuthSheetDescription>
      <form
        className="mt-section flex flex-col gap-lg"
        action={action}
        aria-busy={pending}
        aria-label="パスワードリセットの依頼"
      >
        {error === null ? null : <FormError>{error}</FormError>}
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
        />
        <Button variant="fill" type="submit" disabled={pending}>
          {pending ? "送信中…" : "リセットメールを送る"}
        </Button>
      </form>
    </section>
  );
}
