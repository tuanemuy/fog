import type { ReactElement } from "react";

type IconShape = Readonly<{ viewBox: string; body: ReactElement }>;

const stroke = {
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

// The line art of `spec/design/pages/*.html`, one entry per drawing. The
// mocks draw the same glyph at several sizes; here each glyph is drawn once
// and sized by `IconSize`.
const ICONS = {
  back: {
    viewBox: "0 0 20 20",
    body: <path d="M12.5 4L6.5 10L12.5 16" strokeWidth="1.8" {...stroke} />,
  },
  menu: {
    viewBox: "0 0 20 20",
    body: (
      <path d="M1.5 6.5H18.5M8.3 13.5H18.5" strokeWidth="1.8" {...stroke} />
    ),
  },
  edit: {
    viewBox: "0 0 20 20",
    body: (
      <path
        d="M13.5 3.5L16.5 6.5L7 16H4V13L13.5 3.5Z"
        strokeWidth="1.6"
        {...stroke}
      />
    ),
  },
  history: {
    viewBox: "0 0 20 20",
    body: (
      <>
        <circle cx="10" cy="10" r="7.5" strokeWidth="1.5" {...stroke} />
        <path d="M10 6V10L12.5 11.5" strokeWidth="1.5" {...stroke} />
      </>
    ),
  },
  delete: {
    viewBox: "0 0 20 20",
    body: (
      <path
        d="M4 6H16M8 6V4.5C8 4 8.4 3.5 9 3.5H11C11.6 3.5 12 4 12 4.5V6M6.5 6L7 16C7 16.5 7.5 17 8 17H12C12.5 17 13 16.5 13 16L13.5 6"
        strokeWidth="1.5"
        {...stroke}
      />
    ),
  },
  restore: {
    viewBox: "0 0 20 20",
    body: (
      <path
        d="M4.5 8.2A6 6 0 1 1 4 11.5M4.5 4.5v3.7h3.7"
        strokeWidth="1.7"
        {...stroke}
      />
    ),
  },
  plus: {
    viewBox: "0 0 20 20",
    body: <path d="M10 4V16M4 10H16" strokeWidth="1.7" {...stroke} />,
  },
  minus: {
    viewBox: "0 0 20 20",
    body: <path d="M4 10H16" strokeWidth="1.6" {...stroke} />,
  },
  close: {
    viewBox: "0 0 20 20",
    body: <path d="M5 5L15 15M15 5L5 15" strokeWidth="1.7" {...stroke} />,
  },
  check: {
    viewBox: "0 0 20 20",
    body: <path d="M4 10.5L8.5 15L16 5.5" strokeWidth="1.8" {...stroke} />,
  },
  more: {
    viewBox: "0 0 16 16",
    body: (
      <>
        <circle cx="3" cy="8" r="1.4" fill="currentColor" />
        <circle cx="8" cy="8" r="1.4" fill="currentColor" />
        <circle cx="13" cy="8" r="1.4" fill="currentColor" />
      </>
    ),
  },
  jump: {
    viewBox: "0 0 20 20",
    body: (
      <path d="M5 15L15 5M15 5H7.5M15 5V12.5" strokeWidth="1.8" {...stroke} />
    ),
  },
  "chevron-right": {
    viewBox: "0 0 10 10",
    body: <path d="M3.5 2L7 5L3.5 8" strokeWidth="1.5" {...stroke} />,
  },
  search: {
    viewBox: "0 0 20 20",
    body: (
      <>
        <circle cx="9" cy="9" r="5.5" strokeWidth="1.7" {...stroke} />
        <path d="M13.5 13.5L17 17" strokeWidth="1.7" {...stroke} />
      </>
    ),
  },
  calendar: {
    viewBox: "0 0 20 20",
    body: (
      <>
        <rect
          x="3"
          y="4.5"
          width="14"
          height="12"
          rx="2.5"
          strokeWidth="1.6"
          {...stroke}
        />
        <path d="M3 8.5H17M7 2.8V6M13 2.8V6" strokeWidth="1.6" {...stroke} />
      </>
    ),
  },
  error: {
    viewBox: "0 0 20 20",
    body: (
      <>
        <circle cx="10" cy="10" r="7.5" strokeWidth="1.5" {...stroke} />
        <path d="M10 6.5V10.5M10 13.3V13.5" strokeWidth="1.6" {...stroke} />
      </>
    ),
  },
  warning: {
    viewBox: "0 0 20 20",
    body: (
      <>
        <path d="M10 3.5L17.5 16.5H2.5L10 3.5Z" strokeWidth="1.5" {...stroke} />
        <path d="M10 8.5V11.5M10 14V14.2" strokeWidth="1.6" {...stroke} />
      </>
    ),
  },
  spinner: {
    viewBox: "0 0 20 20",
    body: (
      <>
        <circle
          cx="10"
          cy="10"
          r="7"
          strokeWidth="1.8"
          strokeOpacity="0.25"
          {...stroke}
        />
        <path d="M10 3A7 7 0 0 1 17 10" strokeWidth="1.8" {...stroke} />
      </>
    ),
  },
  google: {
    viewBox: "0 0 24 24",
    body: (
      <path
        d="M20.5 12a8.5 8.5 0 1 1-2.5-6M12 12h8.5"
        strokeWidth="1.6"
        {...stroke}
      />
    ),
  },
  apple: {
    viewBox: "0 0 24 24",
    body: (
      <>
        <path
          d="M16.2 8c2.1.3 3.8 2.2 3.8 4.7 0 3.4-2.4 7.5-4.9 7.5-.9 0-1.5-.6-2.6-.6s-1.8.6-2.7.6C7.3 20.2 5 16.1 5 12.7 5 9.6 7.1 7.8 9.5 7.8c1 0 2 .6 2.6.6.6 0 1.8-.5 3-.4Z"
          strokeWidth="1.6"
          {...stroke}
        />
        <path
          d="M14.8 3.2c-.4 1.2-1.5 2.1-2.7 2.2 0-1.3 1.1-2.6 2.7-2.8 0 .2 0 .4 0 .6Z"
          strokeWidth="1.6"
          {...stroke}
        />
      </>
    ),
  },
} as const satisfies Record<string, IconShape>;

/** Every glyph the UI may draw. Adding one is an edit to this module. */
export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.keys(ICONS) as readonly IconName[];

/** tokens.md's four icon steps — there is no fifth. */
export type IconSize = "lg" | "md" | "sm" | "xs";

const SIZE_CLASS = {
  lg: "size-icon-lg",
  md: "size-icon-md",
  sm: "size-icon-sm",
  xs: "size-icon-xs",
} as const satisfies Record<IconSize, string>;

export type IconProps = Readonly<{ name: IconName; size: IconSize }>;

/**
 * A stroke-line glyph from the closed set above, drawn in `currentColor` at
 * one of tokens.md's four icon sizes.
 *
 * Always decorative (`aria-hidden`): the meaning is carried by the text next
 * to it or by the accessible name of the control around it (`IconButton`'s
 * required `label`). `data-icon` names the glyph for tests. The spinner is the
 * one glyph that moves — the spin animation in `theme.css`, which
 * `prefers-reduced-motion` stops.
 */
export function Icon({ name, size }: IconProps) {
  const { viewBox, body } = ICONS[name];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      viewBox={viewBox}
      fill="none"
      className={
        name === "spinner"
          ? `${SIZE_CLASS[size]} shrink-0 animate-spin`
          : `${SIZE_CLASS[size]} shrink-0`
      }
    >
      {body}
    </svg>
  );
}
