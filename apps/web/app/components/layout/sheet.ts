/**
 * The value of `data-scroll-restoration-id` on the shell's sheet — the
 * element a signed-in screen scrolls in, not the window. The router's
 * `scrollToTopSelectors` names the sheet by it, and scroll restoration keys
 * the sheet's offset on it instead of on a structural `nth-child` path.
 */
export const SHEET_SCROLL_ID = "app-sheet";

export const SHEET_SCROLL_SELECTOR = `[data-scroll-restoration-id="${SHEET_SCROLL_ID}"]`;
