"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";
import { logoutFn } from "./action";

export function LogoutButton() {
  const router = useRouter();
  const logout = useServerFn(logoutFn);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<SerializedError | null>(null);

  const onClick = () => {
    startTransition(async () => {
      try {
        await logout({});
        // Invalidate first so no protected route keeps a cached match,
        // then replace the history entry so Back cannot return to one.
        await router.invalidate();
        await router.navigate({ to: "/login", replace: true });
      } catch (e) {
        setError(extractSerializedError(e));
      }
    });
  };

  return (
    <div className="flex flex-col gap-sm">
      <button
        type="button"
        onClick={onClick}
        disabled={isPending}
        aria-busy={isPending || undefined}
        className="cursor-pointer self-start rounded-sm py-sm text-sm font-medium text-error transition-colors hover:text-error-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-danger disabled:cursor-default disabled:text-neutral-400"
      >
        {isPending ? "ログアウト中…" : "ログアウト"}
      </button>
      {error !== null ? (
        <p role="alert" className="text-sm text-error">
          {displayError(error)}
        </p>
      ) : null}
    </div>
  );
}
