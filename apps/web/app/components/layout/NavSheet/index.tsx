"use client";

import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { NAV_ITEMS } from "@/components/layout/navigation";

export type NavSheetProps = Readonly<{
  id: string;
  open: boolean;
  /** Where the user is; the matching item is marked as the current page. */
  pathname: string;
  onClose: () => void;
}>;

// The card slides up from under the bottom edge. `transition-discrete` keeps
// the closing dialog drawn until the slide ends; without `@starting-style`
// support it opens and closes without the slide.
const DIALOG_CLASS =
  "fixed inset-x-sheet-inset top-auto bottom-[0] m-[0] w-auto max-w-none translate-y-full bg-transparent transition-[translate,overlay,display] transition-discrete duration-default open:translate-y-[0] starting:open:translate-y-full backdrop:bg-overlay lg:hidden";

const ITEM_CLASS =
  "flex w-full items-center gap-sm border-neutral-100 px-xs py-row font-base text-base leading-tight text-neutral-900 not-first:border-t focus-visible:rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

/**
 * The mobile nav (`spec/design/pages/*.html`, `.nav-sheet`): a white card
 * with a handle, rising from the bottom edge on the sheet's horizontal frame,
 * listing the five destinations with the current one marked. It is a native
 * modal `<dialog>`, so focus is held inside, the page
 * behind is inert and Escape closes it; a press on the overlay and choosing
 * an item close it too. Opened from the header's menu; hidden from `lg`,
 * where the sidebar lists the same items.
 */
export function NavSheet({ id, open, pathname, onClose }: NavSheetProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open === open) return;
    // jsdom has neither `showModal` nor `close`; the attribute stands in there.
    if (open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }, [open]);

  return (
    // A click whose target is the `<dialog>` itself landed on the backdrop:
    // the card fills the element, so a press inside it targets the card or
    // something in it. Escape, the keyboard path to the same close, arrives
    // through the native `close` event.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <dialog
      ref={ref}
      id={id}
      aria-label="メニュー"
      className={DIALOG_CLASS}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex flex-col gap-md rounded-t-lg bg-bg-card px-lg pt-md pb-safe-b-2xl shadow-lg">
        <div
          aria-hidden="true"
          className="mx-auto h-handle-h w-handle-w rounded-full bg-neutral-300"
        />
        <nav aria-label="モバイルナビゲーション" className="flex flex-col">
          {NAV_ITEMS.map((item) => {
            const current = item.match(pathname);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={current ? "page" : undefined}
                className={`${ITEM_CLASS} ${current ? "font-semibold" : "font-medium"}`}
                onClick={onClose}
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
      </div>
    </dialog>
  );
}
