"use client";

import { Link, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Brand } from "@/components/ui/Brand";
import { BrandLink } from "@/components/ui/BrandLink";
import { NAV_ITEMS } from "./navItems";

/**
 * The shell every signed-in screen shares.
 *
 * Lives in `_app.tsx`'s `component`, never inside a leaf's
 * `renderServerComponent(...)`: putting it in the RSC payload would remount
 * it on every navigation and drop the nav sheet's open state.
 */

const LINK_FOCUS =
  "focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2";

const SIDE_LINK = `flex items-center gap-sm rounded-md p-(--pad-menu) text-base font-medium transition-colors hover:bg-bg-hover hover:text-neutral-900 ${LINK_FOCUS}`;

const NAV_ITEM = `flex w-full items-center gap-sm px-xs py-row text-base font-medium text-neutral-900 ${LINK_FOCUS} focus-visible:rounded-md`;

function Mark({ current }: { current: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`size-mark flex-none rounded-full ${
        current ? "bg-primary" : "bg-transparent"
      }`}
    />
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Remembering *where* the sheet was opened rather than a boolean makes
  // navigating away close it without an effect.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const navOpen = openedAt === pathname;

  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  // Only an explicit close returns focus to the trigger; closing because the
  // user navigated must leave focus to the incoming page.
  const restoreFocus = useRef(false);

  const openNav = () => setOpenedAt(pathname);
  const closeNav = () => {
    restoreFocus.current = true;
    setOpenedAt(null);
  };

  const current = NAV_ITEMS.find((item) => item.to === pathname);
  const title = current?.label ?? "fog";

  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      restoreFocus.current = true;
      setOpenedAt(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navOpen]);

  // Runs after the `inert` toggle below has been committed, so the element we
  // aim at is focusable by the time we call it.
  useEffect(() => {
    if (navOpen) {
      sheetRef.current?.querySelector("a")?.focus();
      return;
    }
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    menuButtonRef.current?.focus();
  }, [navOpen]);

  return (
    <>
      <div inert={navOpen} className="flex h-dvh lg:mx-auto lg:max-w-page">
        <aside className="hidden w-sidebar flex-none flex-col px-lg pt-2xl pb-lg lg:flex">
          <BrandLink to="/" className={`mb-2xl px-md ${LINK_FOCUS} rounded-md`}>
            <Brand />
          </BrandLink>
          <nav
            aria-label="グローバルナビゲーション"
            className="flex flex-col gap-xs"
          >
            {NAV_ITEMS.map((item) => {
              const isCurrent = item.to === pathname;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={isCurrent ? "page" : undefined}
                  className={`${SIDE_LINK} ${
                    isCurrent
                      ? "font-semibold text-neutral-900"
                      : "text-neutral-600"
                  }`}
                >
                  <Mark current={isCurrent} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="mx-auto flex w-sheet flex-none items-center justify-between gap-md pt-safe-t-lg pb-md md:w-sheet-md lg:pt-xl">
            <div className="flex min-w-0 items-center gap-sm text-lg font-semibold">
              <h1 className="truncate text-lg font-semibold">{title}</h1>
              <span
                aria-hidden="true"
                className="size-dot flex-none rounded-full bg-accent lg:hidden"
              />
            </div>
            <button
              type="button"
              ref={menuButtonRef}
              aria-label="メニュー"
              aria-expanded={navOpen}
              aria-controls="global-nav-sheet"
              onClick={() => (navOpen ? closeNav() : openNav())}
              className={`cursor-pointer rounded-md p-sm text-neutral-500 transition-colors hover:bg-bg-hover hover:text-neutral-900 lg:hidden ${LINK_FOCUS}`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="none"
                className="size-icon-md"
              >
                <path
                  d="M3 7.25H17"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
                <path
                  d="M9 12.75H17"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </header>

          {/* Only the sheet scrolls: header and sidebar stay put, matching
              `.app { height: 100dvh }` + `.sheet { overflow-y: auto }` in
              `spec/design/pages/timeline.html`. The id is what
              `scrollToTopSelectors` in `router.tsx` points at. */}
          <main
            data-scroll-restoration-id="app-sheet"
            className="mx-auto w-sheet flex-1 overflow-y-auto rounded-t-lg bg-bg-card shadow-sm md:w-sheet-md"
          >
            <div className="mx-auto max-w-content px-lg pt-2xl pb-safe-b-2xl sm:px-2xl">
              {children}
            </div>
          </main>
        </div>
      </div>

      {navOpen ? (
        <button
          type="button"
          aria-label="メニューを閉じる"
          onClick={closeNav}
          className="fixed inset-0 z-20 bg-overlay lg:hidden"
        />
      ) : null}
      {navOpen ? (
        <nav
          id="global-nav-sheet"
          ref={sheetRef}
          aria-label="グローバルナビゲーション"
          className="fixed bottom-0 z-30 rounded-t-lg bg-bg-card px-lg pt-md pb-safe-b-2xl shadow-lg inset-x-sheet-inset lg:hidden"
        >
          <div
            aria-hidden="true"
            className="mx-auto mb-md h-handle-h w-handle-w rounded-full bg-neutral-300"
          />
          {NAV_ITEMS.map((item, index) => {
            const isCurrent = item.to === pathname;
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={isCurrent ? "page" : undefined}
                className={`${NAV_ITEM} ${
                  index === 0 ? "" : "border-t border-neutral-100"
                } ${isCurrent ? "font-semibold" : ""}`}
              >
                <Mark current={isCurrent} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      ) : null}
    </>
  );
}
