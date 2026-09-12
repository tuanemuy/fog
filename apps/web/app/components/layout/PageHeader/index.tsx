"use client";

import { useRouter } from "@tanstack/react-router";
import type { MouseEvent, Ref } from "react";
import { BrandLockup } from "@/components/layout/BrandLockup";
import { IconButton } from "@/components/ui/IconButton";
import { IconButtonLink } from "@/components/ui/IconButtonLink";
import type { FileRouteTypes } from "@/routeTree.gen";

/**
 * The noun a back-header names (`spec/design/icons/logo.md`): the thing being
 * looked at, never an operation or a view — editing and history inherit the
 * heading of what they edit.
 */
export type HeaderEntity = "topic" | "memo" | "document";

/**
 * A route's header, declared as `staticData.header`.
 *
 * - `top` — one of the five destinations: the lockup, with `title` as the
 *   page's visually hidden `h1`.
 * - `back` — a page under one of them: the back button and the English
 *   `entity` in the brand face with the orange point. `back` is where the
 *   button leads when there is no in-app history to return through; the
 *   current route's params fill its `$segments`. `h1` says where the page's
 *   `h1` is: the English title in the header, or a heading the screen draws
 *   in its sheet (the document's or the topic's own title), in which case
 *   the English title is a plain label.
 */
export type PageHeaderDeclaration =
  | Readonly<{ kind: "top"; title: string }>
  | Readonly<{
      kind: "back";
      entity: HeaderEntity;
      back: FileRouteTypes["to"];
      h1: "header" | "sheet";
    }>;

/** What the shell draws for a route that declares no header. */
export const UNDECLARED_HEADER: PageHeaderDeclaration = {
  kind: "top",
  title: "fog",
};

export type PageHeaderProps = Readonly<{
  declaration: PageHeaderDeclaration;
  /** Receives the slot `HeaderActions` portals a screen's controls into. */
  actionsRef: Ref<HTMLDivElement>;
  nav: Readonly<{ sheetId: string; open: boolean; onOpen: () => void }>;
}>;

const TITLE_CLASS =
  "flex min-w-[0] items-center gap-sm font-base text-lg font-semibold leading-tight text-neutral-900";

/**
 * The header over the sheet (`spec/design/pages/*.html`, `header.top`): the
 * title on the left, then the screen's controls and the nav menu on the
 * right. It rides the sheet's horizontal frame, so the title's left edge is
 * the text column's. Below `lg` the menu opens the nav sheet; from `lg` the
 * sidebar is always there, so the menu, the header's lockup and the
 * back-title's point are hidden.
 */
export function PageHeader({ declaration, actionsRef, nav }: PageHeaderProps) {
  return (
    <header className="mx-auto flex w-sheet shrink-0 items-center justify-between gap-md pt-safe-t-lg pb-md md:w-sheet-md lg:pt-xl">
      {declaration.kind === "top" ? (
        <div className={TITLE_CLASS}>
          <h1 className="sr-only">{declaration.title}</h1>
          <span className="flex items-center lg:hidden">
            <BrandLockup />
          </span>
        </div>
      ) : (
        <div className="flex min-w-[0] flex-1 items-center gap-md">
          <BackButton to={declaration.back} />
          <div className={TITLE_CLASS}>
            {declaration.h1 === "header" ? (
              <h1 lang="en" className="font-brand font-medium">
                {declaration.entity}
              </h1>
            ) : (
              <span lang="en" className="font-brand font-medium">
                {declaration.entity}
              </span>
            )}
            <span
              aria-hidden="true"
              data-brand-point=""
              className="size-dot shrink-0 rounded-full bg-accent lg:hidden"
            />
          </div>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-xs lg:gap-md">
        <div ref={actionsRef} className="contents" />
        <span className="flex lg:hidden">
          <IconButton
            icon="menu"
            label="メニュー"
            size="md"
            placement="header"
            aria-haspopup="dialog"
            aria-expanded={nav.open}
            aria-controls={nav.sheetId}
            onClick={nav.onOpen}
          />
        </span>
      </div>
    </header>
  );
}

const isPlainClick = (event: MouseEvent) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

/**
 * Back through the in-app history when there is one; otherwise —
 * a page opened from a direct link — to the declared place. It is a link to
 * that place, so it works before hydration and in a new tab too.
 */
function BackButton({ to }: Readonly<{ to: FileRouteTypes["to"] }>) {
  const router = useRouter();
  return (
    <IconButtonLink
      to={to}
      icon="back"
      label="戻る"
      size="lg"
      placement="header"
      onClick={(event) => {
        if (!isPlainClick(event) || !router.history.canGoBack()) return;
        event.preventDefault();
        router.history.back();
      }}
    />
  );
}
