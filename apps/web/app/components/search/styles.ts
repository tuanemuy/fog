// The topic chips of `spec/design/pages/search.html` (`.filter-chips` /
// `.chip`), shared by `SearchPanel` and the skeleton that stands in for it.

export const CHIP_LIST_CLASS = "flex flex-wrap gap-sm";

export const CHIP_CLASS =
  "inline-flex items-center gap-xs rounded-full px-md py-sm font-base text-sm leading-tight transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** A chip that is not the current scope (`aria-pressed="false"`). */
export const CHIP_IDLE_CLASS = "bg-neutral-50 font-medium text-neutral-600";

/** The chip of the current scope (`aria-pressed="true"`). */
export const CHIP_CURRENT_CLASS =
  "bg-primary-lighter font-semibold text-primary-darker";
