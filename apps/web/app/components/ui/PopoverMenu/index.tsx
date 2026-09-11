"use client";

import { createLink } from "@tanstack/react-router";
import {
  type ComponentPropsWithRef,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";

type MenuContext = Readonly<{
  /** Closes the menu; with `refocus`, focus goes back to the trigger. */
  close: (refocus: boolean) => void;
}>;

const PopoverMenuContext = createContext<MenuContext | null>(null);

const useMenu = (): MenuContext => {
  const menu = useContext(PopoverMenuContext);
  if (menu === null) {
    throw new Error("A popover menu item must be drawn inside a PopoverMenu");
  }
  return menu;
};

export type PopoverMenuProps = Readonly<{
  /** The trigger's accessible name, which also names the menu (「メモの操作」). */
  label: string;
  /** `PopoverMenuItem` / `PopoverMenuLink` elements, in menu order. */
  children: ReactNode;
  /**
   * Controlled open state, for a menu that also opens from somewhere else
   * (a right click or a long press on its row). Leave both out and the menu
   * keeps its own.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}>;

const ITEM_SELECTOR = '[role="menuitem"]';

/**
 * The `…` menu of a memo, a topic or a row (`spec/design/pages/timeline.html`,
 * `.entry-pop`): the three-dot trigger, and the card that floats under its
 * lower edge, aligned to its right. Opening moves focus to the first item;
 * the arrow keys, Home and End walk the items; Escape closes and returns
 * focus to the trigger; a press outside or Tab closes it where focus is.
 */
export function PopoverMenu({
  label,
  children,
  open: controlledOpen,
  onOpenChange,
}: PopoverMenuProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerId = useId();
  const menuId = useId();

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  // Held in a ref so the listener below sees the latest `close` — which
  // changes with a controlled owner's callback — without re-subscribing.
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        closeRef.current(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []),
    ];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const target =
      event.key === "ArrowDown"
        ? items[(at + 1) % items.length]
        : event.key === "ArrowUp"
          ? items[(at - 1 + items.length) % items.length]
          : event.key === "Home"
            ? items[0]
            : event.key === "End"
              ? items[items.length - 1]
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <IconButton
        ref={triggerRef}
        id={triggerId}
        icon="more"
        label={label}
        size="sm"
        placement="row"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
      />
      {open ? (
        <PopoverMenuContext.Provider value={{ close }}>
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-labelledby={triggerId}
            onKeyDown={onMenuKeyDown}
            onClick={(event) => {
              const target = event.target as Element;
              if (target.closest('a[role="menuitem"]') !== null) close(false);
            }}
            className="absolute top-full right-[0] z-15 mt-xs flex min-w-popover flex-col rounded-popover bg-bg-card p-xs shadow-md"
          >
            {children}
          </div>
        </PopoverMenuContext.Provider>
      ) : null}
    </div>
  );
}

/**
 * - `neutral` — an ordinary action
 * - `danger` — the destructive one (削除), red; it confirms before it runs
 */
export type PopoverMenuItemTone = "neutral" | "danger";

const ITEM_BASE =
  "flex w-full cursor-pointer items-center gap-sm rounded-md p-(--pad-menu) text-left font-base text-sm font-medium leading-tight transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

const ITEM_TONE = {
  neutral: { text: "text-neutral-900", glyph: "text-neutral-500" },
  danger: { text: "text-error", glyph: "text-error" },
} as const satisfies Record<
  PopoverMenuItemTone,
  Readonly<{ text: string; glyph: string }>
>;

function ItemBody({
  icon,
  tone,
  children,
}: Readonly<{ icon: IconName; tone: PopoverMenuItemTone; children: string }>) {
  return (
    <>
      <span className={`flex shrink-0 ${ITEM_TONE[tone].glyph}`}>
        <Icon name={icon} size="sm" />
      </span>
      {children}
    </>
  );
}

export type PopoverMenuItemProps = Readonly<{
  icon: IconName;
  children: string;
  tone?: PopoverMenuItemTone;
  /** Runs once focus is back on the trigger; the menu closes with it. */
  onSelect: () => void;
}>;

/**
 * An action in a `PopoverMenu`. Choosing it closes the menu and puts focus
 * back on the trigger before `onSelect` runs, so a confirmation opened from
 * it hands focus back to something that still exists when it closes.
 */
export function PopoverMenuItem({
  icon,
  children,
  tone = "neutral",
  onSelect,
}: PopoverMenuItemProps) {
  const menu = useMenu();
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`${ITEM_BASE} ${ITEM_TONE[tone].text}`}
      onClick={() => {
        menu.close(true);
        onSelect();
      }}
    >
      <ItemBody icon={icon} tone={tone}>
        {children}
      </ItemBody>
    </button>
  );
}

type MenuAnchorProps = Omit<
  ComponentPropsWithRef<"a">,
  "className" | "style" | "children" | "role" | "tabIndex"
> &
  Readonly<{ icon: IconName; children: string }>;

// See `ButtonLink`: the router's merged `className` / `style` are overwritten.
// The click stays the router's own; the menu closes on it as it bubbles.
function MenuAnchor({ icon, children, ...rest }: MenuAnchorProps) {
  useMenu();
  return (
    <a
      {...rest}
      role="menuitem"
      tabIndex={-1}
      className={`${ITEM_BASE} ${ITEM_TONE.neutral.text}`}
      style={undefined}
    >
      <ItemBody icon={icon} tone="neutral">
        {children}
      </ItemBody>
    </a>
  );
}

/**
 * A destination in a `PopoverMenu` (履歴): `Link`'s typed props plus the
 * glyph and the words. Following it closes the menu.
 */
export const PopoverMenuLink = createLink(MenuAnchor);
