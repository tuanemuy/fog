import { Icon } from "@/components/ui/Icon";
import type { RetryAction } from "@/components/ui/InlineAlert/styles";

export type RowErrorProps = Readonly<{
  message: string;
  /**
   * Re-runs the row's failed action. Its label is 「リトライ」: a row says
   * that and a surface — a form's head, the composer, an `InlineAlert`, a
   * route error — says 「再試行」, which is how the mocks word the two
   * (`spec/design/pages/trash.html` against `timeline.html`).
   */
  retry?: RetryAction;
}>;

const RETRY_LINK_CLASS =
  "shrink-0 cursor-pointer whitespace-nowrap rounded-sm font-base text-sm font-medium leading-tight text-error-dark underline transition-colors hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * The failure of one row's action (`spec/design/pages/trash.html`,
 * `.row-error`): the error glyph, one sentence and at most one retry. Put it
 * in `Row`'s `error` slot, which lays it under the row across the full width
 * and tightens the row above it; a row-shaped block that is not a `Row` (the
 * export line in settings) puts it right under itself.
 */
export function RowError({ message, retry }: RowErrorProps) {
  return (
    <div
      role="alert"
      className="flex items-center gap-sm rounded-full bg-error-bg px-md py-sm font-base text-sm leading-tight text-error-dark"
    >
      <Icon name="error" size="sm" />
      <span className="min-w-[0] flex-1 wrap-anywhere">{message}</span>
      {retry === undefined ? null : (
        <button
          type="button"
          className={RETRY_LINK_CLASS}
          onClick={retry.onRetry}
        >
          {retry.label}
        </button>
      )}
    </div>
  );
}
