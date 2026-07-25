import type { ReactNode } from "react";
import { Brand } from "@/components/ui/Brand";

type AuthSheetProps = {
  title: string;
  description?: string;
  children: ReactNode;
};

/**
 * The single centred sheet shared by every pre-auth screen
 * (`spec/design/pages/login.html` の `.auth-container` / `.auth-sheet`).
 * No navigation: signed-out screens have no global nav — which is also why
 * the container itself is the `main` landmark: nothing else on these
 * screens could carry it, and without one every signed-out screen (login,
 * signup, password reset, the error and 404 surfaces) leaves its content
 * outside any landmark.
 */
export function AuthSheet({ title, description, children }: AuthSheetProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center px-md pt-(--auth-pad-t) pb-(--auth-pad-b)">
      <div className="w-full max-w-(--auth-sheet-max) rounded-(--radius-lg) bg-bg-card px-lg pt-2xl pb-[calc(2*var(--space-2xl))] shadow-sm sm:px-2xl">
        <div className="mb-2xl flex justify-center">
          <Brand />
        </div>
        <h1
          className={`text-center text-2xl font-bold leading-tight ${
            description === undefined ? "mb-section" : "mb-lg"
          }`}
        >
          {title}
        </h1>
        {description !== undefined ? (
          <p className="mb-section text-center text-sm text-neutral-600 text-balance">
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </main>
  );
}
