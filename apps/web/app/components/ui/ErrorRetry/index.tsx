"use client";

import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";
import { TextLink } from "@/components/ui/TextLink";

/**
 * Shared heading for the error surfaces. Also the generic message for
 * `kind: "unknown"`, so a surface that received exactly this string has
 * nothing to add below the heading.
 */
export const ERROR_TITLE = "エラーが発生しました";

/**
 * Retry affordance shared by the error surfaces (the shared layout in
 * `spec/pages/index.md`). `router.invalidate()` re-runs the failed loaders, so a
 * transient failure recovers without a full page load. `fullWidth` is for
 * the standalone sheet; in the app shell the actions sit at natural width.
 */
export function ErrorRetry({ fullWidth = false }: { fullWidth?: boolean }) {
  const router = useRouter();
  return (
    <div
      className={`flex gap-lg ${fullWidth ? "flex-col" : "flex-wrap items-center"}`}
    >
      <Button
        type="button"
        fullWidth={fullWidth}
        onClick={() => router.invalidate()}
      >
        再読み込み
      </Button>
      <p className={`text-sm ${fullWidth ? "text-center" : ""}`}>
        <TextLink to="/">タイムラインへ</TextLink>
      </p>
    </div>
  );
}
