import { Icon } from "@/components/ui/Icon";
import {
  RETRY_PILL_CLASS,
  type RetryAction,
} from "@/components/ui/InlineAlert/styles";

export type ComposerErrorProps = Readonly<{
  message: string;
  /** Posts the text still in the composer again (「再試行」). */
  retry?: RetryAction;
}>;

/**
 * A failed post, floating right above the composer that owns it
 * (`spec/design/pages/timeline.html`, `.composer-error`). The text stays in
 * the composer, so this is the composer's error, not a toast: it lasts until
 * the next post, and a toast that arrives meanwhile stacks above it. It is
 * the one error surface that floats, hence the shadow; it takes pointer
 * events back from a pass-through wrapper.
 */
export function ComposerError({ message, retry }: ComposerErrorProps) {
  // The retry pill fills the height on its own; without it the box pads to
  // the same height.
  return (
    <div
      role="alert"
      className={`pointer-events-auto flex max-w-full items-center gap-sm rounded-full bg-error-bg pl-md font-base text-sm font-medium leading-tight text-error-dark shadow-md ${retry === undefined ? "py-sm pr-md" : "py-xs pr-xs"}`}
    >
      <span className="flex shrink-0 text-error">
        <Icon name="error" size="sm" />
      </span>
      <span className="min-w-0 wrap-anywhere">{message}</span>
      {retry === undefined ? null : (
        <button
          type="button"
          className={RETRY_PILL_CLASS}
          onClick={retry.onRetry}
        >
          {retry.label}
        </button>
      )}
    </div>
  );
}
