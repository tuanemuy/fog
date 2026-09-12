// The timeline's own shapes (`spec/design/pages/timeline.html`), shared by the
// loaded list and its skeleton so the one swaps in for the other without a
// shift.

/** A day's group: the break above every group but the first (`.day-head`). */
export const DAY_GROUP_CLASS = "not-first:pt-lg";

/** The date heading, with an optional note beside it (`.day-head .sub`). */
export const DAY_HEADING_CLASS =
  "flex flex-wrap items-baseline gap-sm pb-md font-base text-sm font-semibold leading-tight text-neutral-900";

export const DAY_HEADING_NOTE_CLASS =
  "font-base text-xs font-regular text-neutral-400";

/** The entries under one heading (`.entry + *`). */
export const DAY_ENTRIES_CLASS = "flex flex-col gap-xs";

/** One entry (`.entry`); the target of a position-specified visit is tinted. */
export const ENTRY_CLASS = "py-sm";
export const HIGHLIGHTED_ENTRY_CLASS =
  "-mx-md rounded-md bg-primary-lighter px-md py-sm";

/** The time on the left, the entry's menu on the right (`.entry-head`). */
export const ENTRY_HEAD_CLASS = "flex items-center justify-between gap-sm";

export const TIME_LABEL_CLASS =
  "font-base text-xs font-medium leading-tight tracking-label tabular-nums text-neutral-400";

/** The body under the head (`.entry .items`). */
export const ENTRY_BODY_CLASS = "pt-xs";
