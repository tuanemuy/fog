"use client";

import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
} from "react";
import { createPortal } from "react-dom";

// `undefined` is "no shell around this"; `null` is "the shell is there but
// its slot has not mounted yet" — the SSR pass and the first client render.
const HeaderActionsSlot = createContext<HTMLElement | null | undefined>(
  undefined,
);
const DockSlot = createContext<HTMLElement | null | undefined>(undefined);

const NO_SCROLL_CONTAINER: RefObject<HTMLElement | null> = { current: null };
const SheetScrollContainer =
  createContext<RefObject<HTMLElement | null>>(NO_SCROLL_CONTAINER);

export type ShellSlotsProviderProps = Readonly<{
  headerActions: HTMLElement | null;
  dock: HTMLElement | null;
  sheet: RefObject<HTMLElement | null>;
  children: ReactNode;
}>;

/** Hands the shell's slots and its scroll container to the screen under it. */
export function ShellSlotsProvider({
  headerActions,
  dock,
  sheet,
  children,
}: ShellSlotsProviderProps) {
  return (
    <HeaderActionsSlot.Provider value={headerActions}>
      <DockSlot.Provider value={dock}>
        <SheetScrollContainer.Provider value={sheet}>
          {children}
        </SheetScrollContainer.Provider>
      </DockSlot.Provider>
    </HeaderActionsSlot.Provider>
  );
}

function usePortalTarget(
  context: typeof HeaderActionsSlot,
  name: string,
): HTMLElement | null {
  const target = useContext(context);
  if (target === undefined) {
    throw new Error(`${name} must be drawn inside the AppShell`);
  }
  return target;
}

/**
 * Puts a screen's controls into the header, left of the nav menu: the
 * actions that need the screen's data or state — delete with
 * the topic id, save with the form, the timeline's filter and date jump. The
 * portal is opened once the header has mounted, so the controls are not in
 * the server HTML and appear after hydration. Throws outside the shell,
 * rather than dropping the controls silently.
 */
export function HeaderActions({ children }: Readonly<{ children: ReactNode }>) {
  const target = usePortalTarget(HeaderActionsSlot, "HeaderActions");
  return target === null ? null : createPortal(children, target);
}

/**
 * Puts something into the floating dock at the bottom of the shell, under
 * the toasts and on the same centre axis (`spec/design/pages/timeline.html`:
 * a toast stands right above the composer, and at the same bottom edge on a
 * screen without one). The dock takes no pointer events; whatever is put in
 * it takes them back itself. Mounted after hydration and throwing outside the
 * shell, as `HeaderActions`.
 */
export function BottomDock({ children }: Readonly<{ children: ReactNode }>) {
  const target = usePortalTarget(DockSlot, "BottomDock");
  return target === null ? null : createPortal(children, target);
}

/**
 * The element the screen scrolls in — the shell's sheet, not the window.
 * Read `.current` in an effect: by then the sheet has mounted. Outside the
 * shell it stays `null`, which an `IntersectionObserver` reads as the
 * viewport.
 */
export function useSheetScrollContainer(): RefObject<HTMLElement | null> {
  return useContext(SheetScrollContainer);
}
