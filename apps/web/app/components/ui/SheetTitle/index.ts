/**
 * The name of what a sheet is about, drawn as the page's own heading: a
 * document's title (`.doc-title`), a topic's name (`.topic-title`), and the
 * subject a history is of (`.doc-title` in
 * `spec/design/pages/document-history.html`). The loaded screens, their
 * skeletons and the editor's title input read this one string, so a line
 * keeps its height when the skeleton gives way to it.
 *
 * It carries no layout: a title inside a flex row adds its own `min-w-[0]`.
 */
export const SHEET_TITLE_CLASS =
  "font-base text-xl font-bold leading-tight text-neutral-900 wrap-anywhere";
