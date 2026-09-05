"use client";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { beginFogGoogle } from "@/presentation/fogAccountActions";

export function GoogleButton({
  returnTo = "/timeline",
  link = false,
}: {
  returnTo?: string;
  link?: boolean;
}) {
  const begin = useServerFn(beginFogGoogle);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fog-google-action">
      <button
        type="button"
        className="fog-secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            try {
              const result = await begin({ data: { returnTo } });
              window.location.assign(result.url);
            } catch (failure) {
              setError(displayError(failure));
            }
          })
        }
      >
        {pending
          ? "認証画面へ移動中…"
          : link
            ? "Google連携を追加"
            : "Googleで続行"}
      </button>
      {error && (
        <p className="fog-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
