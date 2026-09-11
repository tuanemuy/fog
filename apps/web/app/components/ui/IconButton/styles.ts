/**
 * Where an icon-only control sits, which decides its box.
 *
 * - `header` — on the page background: a padded box with a hover surface. At
 *   `lg` and up the box shrinks to the glyph so the ink sits on the column's
 *   edge (`spec/design/pages/document.html`, `.h-actions`).
 * - `row` — inside the sheet: the glyph plus `--space-xs`, no hover surface —
 *   only the color reacts (`spec/design/pages/trash.html`, `.row-actions`).
 */
export type IconButtonPlacement = "header" | "row";

/**
 * - `neutral` — gray, darkening on hover
 * - `primary` — the primary color (restore)
 * - `danger` — gray turning red on hover, with the red focus ring
 */
export type IconButtonTone = "neutral" | "primary" | "danger";

const BASE =
  "inline-flex shrink-0 cursor-pointer items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:text-neutral-300";

const PLACEMENT = {
  header:
    "rounded-md p-sm not-disabled:hover:bg-bg-hover lg:p-[0] lg:not-disabled:hover:bg-transparent",
  row: "rounded-sm p-xs",
} as const satisfies Record<IconButtonPlacement, string>;

const TONE = {
  neutral:
    "text-neutral-500 focus-visible:outline-focus not-disabled:hover:text-neutral-900",
  primary:
    "text-primary focus-visible:outline-focus not-disabled:hover:text-primary-dark",
  danger:
    "text-neutral-500 focus-visible:outline-focus-danger not-disabled:hover:text-error",
} as const satisfies Record<IconButtonTone, string>;

/** Shared by `IconButton` and `IconButtonLink`. */
export const iconButtonClassName = (
  placement: IconButtonPlacement,
  tone: IconButtonTone,
): string => `${BASE} ${PLACEMENT[placement]} ${TONE[tone]}`;
