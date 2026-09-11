import { screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { ToastProvider, ToastRegion } from "@/components/ui/Toast";

/**
 * The frame's half of the toasts (`AppShell` / `AuthSheet`): the provider
 * around the screen under test and the one region it draws toasts in.
 */
export function withToasts(element: ReactElement): ReactElement {
  return (
    <ToastProvider>
      {element}
      <ToastRegion />
    </ToastProvider>
  );
}

/** The sentences the frame's toast region shows right now. */
export function toastsShown(): string[] {
  const region = screen
    .getAllByRole("status")
    .find((element) => element.getAttribute("aria-live") === "polite");
  if (region === undefined) throw new Error("no toast region is drawn");
  return [...region.children].map((toast) => toast.textContent ?? "");
}
