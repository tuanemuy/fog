// The document screens' own pieces (`spec/design/pages/document.html` /
// `document-edit.html`). The loaded screens and their skeletons read the same
// strings, so a line keeps its height when the skeleton gives way to it.

/** `.doc-context`: the topic the document belongs to, over its title. */
export const DOC_CONTEXT_CLASS =
  "font-base text-sm leading-tight text-neutral-600 next-sibling:mt-sm";

/** The topic link inside it: the line's own color, no underline. */
export const DOC_CONTEXT_LINK_CLASS =
  "rounded-sm text-neutral-600 no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** `.doc-title`, which the title input of the editor shares. */
export const DOC_TITLE_CLASS =
  "font-base text-xl font-bold leading-tight text-neutral-900 wrap-anywhere";

/** `.doc-meta`: the update time under the title. */
export const DOC_META_CLASS =
  "mt-sm flex items-center gap-md font-base text-xs leading-tight text-neutral-400 tabular-nums";

/** `.doc-body`: the rendered body, a section's gap under the meta line. */
export const DOC_BODY_CLASS = "mt-section";

/**
 * `.title-input`: the title as the heading it becomes, with no box. Title and
 * body run on as one seamless editor, so neither draws a border or a ring —
 * the caret is where the focus shows.
 */
export const TITLE_INPUT_CLASS = `block w-full min-w-0 bg-transparent outline-none placeholder:text-neutral-400 ${DOC_TITLE_CLASS}`;

/**
 * `.body-input`: the body in the reading leading, growing with its content so
 * the sheet scrolls rather than the field (five lines at the least).
 */
export const BODY_INPUT_CLASS =
  "mt-lg block min-h-[5lh] w-full resize-none bg-transparent font-base text-base leading-loose text-neutral-900 outline-none field-sizing-content placeholder:text-neutral-400";

/** `.origin` / `.reason`: a section after the body, over its hairline. */
export const DOC_SECTION_CLASS = "mt-section border-t border-neutral-100 pt-lg";

/** The alerts that open the sheet (a conflict, a failed save or delete). */
export const SHEET_ALERTS_CLASS = "flex flex-col gap-sm next-sibling:mt-lg";
