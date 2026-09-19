"use client";

import { useServerFn } from "@tanstack/react-start";
import { useActionState } from "react";
import { logoutFn } from "@/components/auth/actions";
import { isSessionEndedResult } from "@/components/auth/schema";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";

/**
 * S-AC-04, in the neutral text step (logging out destroys nothing). A full
 * navigation afterwards, so no cached protected screen survives; a failure
 * goes first in the form.
 */
export function LogoutButton() {
  const logout = useServerFn(logoutFn);
  const [error, action, pending] = useActionState<string | null, FormData>(
    async () => {
      try {
        readServerFnResult(await logout({}), isSessionEndedResult, "logoutFn");
      } catch (failure) {
        return displayError(failure);
      }
      window.location.assign("/login");
      return null;
    },
    null,
  );
  return (
    <form action={action} className="inline-flex flex-col items-start gap-sm">
      {error && <FormError>{error}</FormError>}
      <Button variant="text" type="submit" disabled={pending}>
        {pending ? "ログアウト中…" : "ログアウト"}
      </Button>
    </form>
  );
}
