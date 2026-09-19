/**
 * The button steps of the base forms (`spec/design/index.md`). The icon-only
 * step is `IconButton`.
 *
 * - `fill` — the form's main action and the one action of an empty state
 * - `fill-sm` — header save, inline add, a settings row's action
 * - `outline` — a secondary action beside a fill, an SSO provider
 * - `text` — cancel, log out
 * - `danger-text` — a destructive action that confirms before it runs
 */
export type ButtonVariant =
  | "fill"
  | "fill-sm"
  | "outline"
  | "text"
  | "danger-text";

// Hover goes through `not-disabled:` rather than `enabled:` so the same string
// serves `<a>`, which never matches `:enabled`.
const BASE =
  "inline-flex cursor-pointer items-center justify-center gap-sm whitespace-nowrap font-base text-sm font-medium leading-tight transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default";

const VARIANT = {
  fill: "rounded-full bg-primary-dark p-(--pad-btn) text-text-inverse focus-visible:outline-focus not-disabled:hover:bg-primary-darker not-disabled:active:bg-primary-darker disabled:bg-neutral-200 disabled:text-neutral-400",
  "fill-sm":
    "rounded-full bg-primary-dark p-(--pad-btn-sm) text-text-inverse focus-visible:outline-focus not-disabled:hover:bg-primary-darker not-disabled:active:bg-primary-darker disabled:bg-neutral-200 disabled:text-neutral-400",
  outline:
    "rounded-full bg-transparent p-(--pad-btn-sm) text-neutral-900 [border:var(--border-input)] focus-visible:outline-focus not-disabled:hover:border-neutral-600 disabled:border-neutral-100 disabled:text-neutral-400",
  text: "rounded-full bg-transparent p-(--pad-btn-sm) text-neutral-600 focus-visible:outline-focus not-disabled:hover:bg-neutral-50 not-disabled:hover:text-neutral-900 disabled:text-neutral-300",
  "danger-text":
    "rounded-sm bg-transparent px-md py-sm text-error focus-visible:outline-focus-danger not-disabled:hover:text-error-dark disabled:text-neutral-300",
} as const satisfies Record<ButtonVariant, string>;

/** The classes of one button step, shared by `Button` and `ButtonLink`. */
export const buttonClassName = (variant: ButtonVariant): string =>
  `${BASE} ${VARIANT[variant]}`;
