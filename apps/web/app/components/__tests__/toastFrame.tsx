import { screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { ToastProvider, ToastRegion } from "@/components/ui/Toast";

/**
 * The frame's half of the toasts (`AppShell` / `AuthSheet`): the provider
 * around the screen under test and the one region it draws toasts in. A
 * screen drawn inside a frame of its own already has both — find its region
 * with `toastRegion` instead of wrapping it again.
 */
export function withToasts(element: ReactElement): ReactElement {
  return (
    <ToastProvider>
      {element}
      <ToastRegion />
    </ToastProvider>
  );
}

/**
 * The frame's toast region, wherever the frame under test puts it: the one
 * live region that announces additions only (`aria-atomic="false"`), which is
 * what tells it from a screen's own `role="status"` — a loading row, a busy
 * diff box — that may be on the page beside it.
 */
export function toastRegion(): HTMLElement {
  const region = screen
    .getAllByRole("status")
    .find((element) => element.getAttribute("aria-atomic") === "false");
  if (region === undefined) throw new Error("no toast region is drawn");
  return region;
}

/** The sentences the frame's toast region shows right now. */
export function toastsShown(): string[] {
  return [...toastRegion().children].map((toast) => toast.textContent ?? "");
}
