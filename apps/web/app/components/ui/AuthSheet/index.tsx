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
 * the design): the *first* child must not declare one of its own — the
 * wrapper is a flex column, so its `margin-top` would add to the sheet's
 * `--space-section` instead of collapsing into it. Margins between the
 * children themselves are theirs to own (`.form-links` in the design).
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
        {/* 本文の上余白はシート側が持つ。ErrorRetry は className を
            受け取らないため利用側には配れない */}
        <div className="mt-section flex flex-col">{children}</div>
      </div>
    </main>
  );
}
