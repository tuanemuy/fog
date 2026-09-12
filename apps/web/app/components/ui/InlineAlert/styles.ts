/** The control that re-runs the failed action, and the words on it. */
export type RetryAction = Readonly<{ label: string; onRetry: () => void }>;

/**
 * The retry pill on an error surface — the card on the error background
 * (`.composer-retry` in `timeline.html`, `.alert-retry` in
 * `document-edit.html`). Shared by `InlineAlert` and `ComposerError`.
 */
export const RETRY_PILL_CLASS =
  "shrink-0 cursor-pointer whitespace-nowrap rounded-full bg-bg-card px-md py-xs font-base text-sm font-medium leading-tight text-error-dark transition-colors hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
