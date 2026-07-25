import type { ReactNode } from "react";
import { Brand } from "@/components/ui/Brand";

type AuthSheetProps = {
  title: string;
  description?: string;
  children: ReactNode;
};

/**
 * The centred sheet shared by every pre-auth screen
 * (`spec/design/pages/login.html` の `.auth-container` / `.auth-sheet`).
 * Signed-out screens have no global nav, so this container is the `main`
 * landmark — nothing else on these screens could carry it.
 *
 * 余白はアプリ画面のシートと違い上下対称: このシートはスクロールせず
 * 縦中央に置くので、非対称だと中身が上へずれて見える。
 */
export function AuthSheet({ title, description, children }: AuthSheetProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-md pt-safe-t-xl pb-safe-b-xl">
      <div className="w-full max-w-narrow rounded-lg bg-bg-card px-lg py-2xl shadow-sm sm:px-2xl">
        <div className="mb-section flex justify-center">
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
