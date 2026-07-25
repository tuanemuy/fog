"use client";

import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";
import { TextLink } from "@/components/ui/TextLink";

/**
 * The heading every error surface shows. Also the generic message
 * `renderErrorMessage` produces for `kind: "unknown"`, so a surface that
 * received exactly this string has nothing to add below the heading.
 */
export const ERROR_TITLE = "エラーが発生しました";

/**
 * The retry affordance shared by the two error surfaces
 * (`spec/pages/index.md` 共通レイアウト: 通信エラーは共通のエラー表示
 * （リトライ導線付き）で扱う).
 *
 * `router.invalidate()` re-runs the loaders that failed, so a transient
 * failure recovers without a full page load. `fullWidth` is for the
 * standalone sheet, whose buttons span it (`login.html` の `.btn`); inside
 * the app shell the same actions sit on one row at their natural width.
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
