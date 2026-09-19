"use client";

import { Link, useMatches, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useId, useRef, useState } from "react";
import { BrandLockup } from "@/components/layout/BrandLockup";
import { NavSheet } from "@/components/layout/NavSheet";
import { NAV_ITEMS } from "@/components/layout/navigation";
import {
  PageHeader,
  type PageHeaderDeclaration,
  UNDECLARED_HEADER,
} from "@/components/layout/PageHeader";
import { ShellSlotsProvider } from "@/components/layout/ShellSlots";
import { SHEET_SCROLL_ID } from "@/components/layout/sheet";
import { PageHeadingOwnerProvider } from "@/components/ui/PageHeading";
import { ToastProvider, ToastRegion } from "@/components/ui/Toast";

/** The deepest match's declaration wins: a leaf route over its layouts. */
function useHeaderDeclaration(): PageHeaderDeclaration {
  return useMatches({
    select: (matches) => {
      for (let i = matches.length - 1; i >= 0; i -= 1) {
        const header = matches[i]?.staticData.header;
        if (header !== undefined) return header;
      }
      return UNDECLARED_HEADER;
    },
  });
}

const SIDE_LINK_CLASS =
  "flex items-center gap-sm rounded-md p-(--pad-menu) font-base text-base leading-tight transition-colors hover:bg-bg-hover hover:text-neutral-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

/**
 * The frame of every signed-in screen (`spec/design/index.md`「UI 構造」):
 * the sidebar from `lg`, and a column of the header over the white sheet,
 * both on one horizontal frame. The sheet is the scroll container — the
 * header stays and the screen scrolls under it. Below `lg` the header's menu
 * opens the nav sheet.
 *
 * Inside the sheet the shell holds the text column: the top and side
 * padding and `--content-max`, the same on every screen. The bottom is the
 * screen's: `pb-sheet-end`, or `pb-sheet-end-composer`
 * on a screen whose composer floats over the foot of the sheet.
 *
 * The header is drawn from the deepest route's `staticData.header`; a screen
 * puts its data-dependent controls into it
 * with `HeaderActions`. A route that declares `h1: "sheet"` keeps its `h1`
 * in the sheet, so whatever is drawn in place of that screen — a route
 * error, a 404 — is told that the heading is its to draw
 * (`usePageHeadingOwner`). The shell hosts the toasts: the region
 * floats at the bottom of the column, and `BottomDock` stacks whatever the
 * screen floats there (the composer) under it.
 */
export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const declaration = useHeaderDeclaration();
  const navSheetId = useId();
  const [navOpen, setNavOpen] = useState(false);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [dockSlot, setDockSlot] = useState<HTMLElement | null>(null);
  const sheet = useRef<HTMLElement>(null);

  return (
    <ToastProvider>
      <div className="flex h-dvh lg:mx-auto lg:max-w-page">
        <div className="fixed top-md left-md z-10">
          <a
            href="#main"
            className="sr-only rounded-md bg-bg-card p-sm font-base text-sm text-neutral-900 focus:not-sr-only"
          >
            本文へ移動
          </a>
        </div>
        <aside className="hidden lg:flex lg:w-sidebar lg:shrink-0 lg:flex-col lg:gap-2xl lg:px-lg lg:pt-2xl lg:pb-lg">
          <Link
            to="/"
            aria-label="fog タイムライン"
            className="flex items-center rounded-md px-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <BrandLockup />
          </Link>
          <nav
            aria-label="メインナビゲーション"
            className="flex flex-col gap-xs"
          >
            {NAV_ITEMS.map((item) => {
              const current = item.match(pathname);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={current ? "page" : undefined}
                  className={`${SIDE_LINK_CLASS} ${current ? "font-semibold text-neutral-900" : "font-medium text-neutral-600"}`}
                >
                  <span
                    aria-hidden="true"
                    className={`size-dot shrink-0 rounded-full ${current ? "bg-primary" : "bg-transparent"}`}
                  />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <div className="relative flex min-w-[0] flex-1 flex-col">
          <PageHeader
            declaration={declaration}
            actionsRef={setActionsSlot}
            nav={{
              sheetId: navSheetId,
              open: navOpen,
              onOpen: () => setNavOpen(true),
            }}
          />
          <main
            id="main"
            ref={sheet}
            data-scroll-restoration-id={SHEET_SCROLL_ID}
            className="mx-auto w-sheet flex-1 overflow-y-auto rounded-t-lg bg-bg-card shadow-sm md:w-sheet-md"
          >
            <div className="mx-auto max-w-content px-lg pt-2xl sm:px-2xl">
              <ShellSlotsProvider
                headerActions={actionsSlot}
                dock={dockSlot}
                sheet={sheet}
              >
                <PageHeadingOwnerProvider
                  owner={
                    declaration.kind === "back" && declaration.h1 === "sheet"
                      ? "screen"
                      : "frame"
                  }
                >
                  {children}
                </PageHeadingOwnerProvider>
              </ShellSlotsProvider>
            </div>
          </main>
          <div className="pointer-events-none absolute inset-x-[0] bottom-safe-b-xl flex flex-col items-center gap-sm px-2xl">
            <ToastRegion />
            <div ref={setDockSlot} className="contents" />
          </div>
        </div>
      </div>
      <NavSheet
        id={navSheetId}
        open={navOpen}
        pathname={pathname}
        onClose={() => setNavOpen(false)}
      />
    </ToastProvider>
  );
}
