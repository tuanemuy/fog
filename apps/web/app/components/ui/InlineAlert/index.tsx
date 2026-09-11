import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { RETRY_PILL_CLASS, type RetryAction } from "./styles";

export type { RetryAction } from "./styles";

/**
 * - `info` — a state that holds as long as the screen is open and is read
 *   back before acting (the reset mail has been sent). Not a success: a
 *   success is a toast.
 * - `warning` — something to weigh before going on (another writer edited
 *   the memo being saved)
 * - `error` — a failure that keeps the screen as it was (the save failed),
 *   optionally with a retry
 */
export type InlineAlertTone = "info" | "warning" | "error";

export type InlineAlertProps = Readonly<{ children: ReactNode }> &
  (
    | Readonly<{ tone: "info" | "warning"; retry?: never }>
    | Readonly<{ tone: "error"; retry?: RetryAction }>
  );

type ToneLook = Readonly<{
  box: string;
  glyph: Readonly<{ name: IconName; color: string }> | null;
  role: "status" | "alert";
}>;

// Text on a tinted surface is always the `-dark` / `-darker` step
// (tokens.md のコントラスト規約); the glyph takes the plain step.
const TONE = {
  info: {
    box: "items-start bg-info-bg text-primary-darker",
    glyph: null,
    role: "status",
  },
  warning: {
    box: "items-start bg-warning-bg text-warning-dark",
    glyph: { name: "warning", color: "text-warning" },
    role: "alert",
  },
  error: {
    box: "items-center bg-error-bg text-error-dark",
    glyph: { name: "error", color: "text-error" },
    role: "alert",
  },
} as const satisfies Record<InlineAlertTone, ToneLook>;

/**
 * A notice that stays on the screen, attached to what it is about
 * (`spec/design/pages/timeline.html` / `document-edit.html`,
 * `.inline-alert`). The glyph sits in a one-line box so it lines up with the
 * first line of a wrapped sentence. Only the error tone takes a retry — the
 * union makes a retry on the other two unwritable.
 *
 * What does not stay — a success, a one-off notice with nothing on the screen
 * to attach to — is a toast (`useToast`), never this.
 */
export function InlineAlert({ tone, children, retry }: InlineAlertProps) {
  const look = TONE[tone];
  return (
    <div
      role={look.role}
      className={`flex gap-sm rounded-md px-md py-sm font-base text-sm leading-normal ${look.box}`}
    >
      {look.glyph === null ? null : (
        <span
          className={`flex h-[1lh] shrink-0 items-center ${look.glyph.color}`}
        >
          <Icon name={look.glyph.name} size="sm" />
        </span>
      )}
      <div className="min-w-0 flex-1 wrap-anywhere">{children}</div>
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
