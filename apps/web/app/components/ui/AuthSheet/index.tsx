import type { ReactNode } from "react";
import { Brand } from "@/components/ui/Brand";

type AuthSheetProps = {
  title: string;
  description?: string;
  children: ReactNode;
};

/**
 * The centred sheet shared by every pre-auth screen
 * (`.auth-container` / `.auth-sheet` in `spec/design/pages/login.html`).
 * Signed-out screens have no global nav, so this container is the `main`
 * landmark — nothing else on these screens could carry it.
 *
 * The body's top margin belongs to the sheet (`.auth-form { margin-top }` in
 * the design): `children` must not declare one of its own. The wrapper is a
 * flex column, so a child's `margin-top` adds to the sheet's
 * `--space-section` instead of collapsing into it.
 */
export function AuthSheet({ title, description, children }: AuthSheetProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-md pt-safe-t-xl pb-safe-b-xl">
      <div className="w-full max-w-narrow rounded-lg bg-bg-card px-lg py-2xl shadow-sm sm:px-2xl">
        <div className="flex justify-center">
          <Brand />
        </div>
        <h1 className="mt-section text-center text-2xl font-bold leading-tight">
          {title}
        </h1>
        {description !== undefined ? (
          <p className="mt-lg text-center text-sm text-neutral-600 text-balance">
            {description}
          </p>
        ) : null}
        {/* 本文の上余白はシート側が持つ。children の形は画面ごとに不揃いで、
            ErrorRetry は className を受け取らないため。flex にするのは、children
            先頭の mt-* が親子マージン相殺に飲まれて和にならないのを避けるため */}
        <div className="mt-section flex flex-col">{children}</div>
      </div>
    </main>
  );
}
