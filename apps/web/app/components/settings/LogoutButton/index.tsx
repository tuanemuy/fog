"use client";

import { useServerFn } from "@tanstack/react-start";
import { useActionState } from "react";
import { logoutFn } from "@/components/auth/actions";
import { isSessionEndedResult } from "@/components/auth/schema";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";

/** S-AC-04. A full navigation afterwards, so no cached protected screen survives. */
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
    <form action={action} className="fog-account">
      <button type="submit" className="fog-secondary" disabled={pending}>
        {pending ? "ログアウト中…" : "ログアウト"}
      </button>
      {error && (
        <p role="alert" className="fog-error">
          {error}
        </p>
      )}
    </form>
  );
}
