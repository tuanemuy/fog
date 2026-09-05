"use client";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { deleteFogContent } from "@/presentation/fogDataActions";
import type { ContentTarget } from "@/presentation/fogDataSchema";
import { ConfirmDialog } from "./ConfirmDialog";

export function ContentDeletion({
  target,
  title,
  expectedVersion,
}: {
  target: ContentTarget;
  title: string;
  expectedVersion: number;
}) {
  const router = useRouter();
  const remove = useServerFn(deleteFogContent);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fog-content-deletion">
      <button
        type="button"
        className="fog-text-button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        ゴミ箱に移す
      </button>
      {open && (
        <ConfirmDialog
          title="ゴミ箱に移しますか？"
          pending={pending}
          onCancel={() => setOpen(false)}
        >
          <p>{title}</p>
          <p>
            {target.kind === "topic"
              ? "配下のドキュメントも一緒にゴミ箱へ移ります。保持期限内なら復元できます。"
              : "保持期限内なら、ゴミ箱から復元できます。"}
          </p>
          {error && (
            <p role="alert" className="fog-error">
              {error}
            </p>
          )}
          <button
            type="button"
            className="fog-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                try {
                  await remove({ data: { ...target, expectedVersion } });
                  await router.navigate({ to: "/topics" });
                  await router.invalidate();
                } catch (failure) {
                  setError(displayError(failure));
                }
              })
            }
          >
            {pending ? "移動中…" : "ゴミ箱に移す"}
          </button>
        </ConfirmDialog>
      )}
    </div>
  );
}
