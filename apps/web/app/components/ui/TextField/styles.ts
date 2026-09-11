// The field box both text controls share (`.form-input` in
// `spec/design/pages/login.html`): the input border, the card surface, the
// primary border and ring on focus, the error border while invalid. The
// focus border steps aside for an invalid field so the red stays.
const FIELD_BOX =
  "w-full min-w-0 rounded-md bg-bg-card font-base text-base text-neutral-900 [border:var(--border-input)] transition-colors placeholder:text-neutral-400 focus:not-aria-invalid:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-invalid:border-error read-only:text-neutral-600 disabled:text-neutral-600";

/** One line: the input box of the form (`--pad-input`). */
export const TEXT_INPUT_CLASS = `${FIELD_BOX} p-(--pad-input) leading-tight`;

/**
 * Several lines (`.edit-field` / `.memo-edit` in `topics.html` /
 * `timeline.html`): the reading leading, at least two lines tall, growing
 * with its content where the browser sizes a field by its content.
 */
export const TEXT_AREA_CLASS = `${FIELD_BOX} block min-h-[calc(2lh+2*var(--space-sm))] resize-none px-md py-sm leading-normal field-sizing-content`;
