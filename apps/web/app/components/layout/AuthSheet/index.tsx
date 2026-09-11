"use client";

import type { ReactNode } from "react";
import { BrandLockup } from "@/components/layout/BrandLockup";
import { PageHeadingOwnerProvider } from "@/components/ui/PageHeading";
import { RouteError } from "@/components/ui/RouteError";
import { ToastProvider, ToastRegion } from "@/components/ui/Toast";

/**
 * The frame of the screens drawn without the app's navigation
 * (`spec/design/pages/login.html`, `.auth-container` / `.auth-sheet`): one
 * white card in the middle of the page, both ways, with the lockup at its
 * head. The `_sheet` layout draws it around login, signup, the password
 * reset and its done page, and AI client authorization (ADR-008 of Issue
 * #22); the screen draws only what comes after the lockup.
 *
 * The card holds its own padding on all four sides and the same on top and
 * bottom: it does not scroll, so the escape room at the foot of the app's
 * sheet would only push its content up (`spec/design/index.md`「余白と区切り」).
 * It hosts the toasts (ADR-010), fixed at the bottom centre of the page.
 *
 * The frame draws no heading: the screen's `AuthSheetTitle` is the page's
 * `h1`, and a route error or 404 standing in for the screen makes its
 * sentence the `h1` instead (`PageHeadingOwnerProvider`).
 */
export function AuthSheet({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ToastProvider>
      <div className="flex min-h-dvh flex-col items-center justify-center px-md py-xl">
        <main className="w-full max-w-narrow rounded-lg bg-bg-card px-lg py-2xl text-neutral-900 shadow-sm sm:px-2xl">
          <div className="flex justify-center">
            <BrandLockup />
          </div>
          <PageHeadingOwnerProvider owner="screen">
            {children}
          </PageHeadingOwnerProvider>
        </main>
      </div>
      <div className="pointer-events-none fixed inset-x-[0] bottom-safe-b-xl flex flex-col items-center px-md">
        <ToastRegion />
      </div>
    </ToastProvider>
  );
}

/**
 * The page's title under the lockup (`.page-title` in every auth-sheet mock):
 * the screen's `h1`, centred, a section's space below the lockup.
 */
export function AuthSheetTitle({
  id,
  children,
}: Readonly<{ id?: string; children: ReactNode }>) {
  return (
    <h1
      id={id}
      className="mt-section text-center font-base text-2xl font-bold leading-tight text-balance break-keep wrap-anywhere"
    >
      {children}
    </h1>
  );
}

/**
 * The error component of the root and of the two layouts under it, `_app`
 * and `_sheet` (ADR-009 of Issue #22): their failure takes the frame down
 * with it, so the route error is drawn on the auth sheet instead of bare.
 */
export function AuthSheetRouteError() {
  return (
    <AuthSheet>
      <RouteError />
    </AuthSheet>
  );
}
