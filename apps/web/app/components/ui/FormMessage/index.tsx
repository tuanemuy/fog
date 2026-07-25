import type { ReactNode } from "react";

/**
 * Form-level error banner (`spec/design/pages/login.html` の `.error-message`).
 *
 * `role="alert"` so the message is announced when it appears after a
 * failed submit. Field-scoped messages belong on `TextField` instead —
 * errors are shown where they can be acted on.
 */
export function FormMessage({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-(--radius-md) border border-error bg-error-bg p-(--pad-input) text-sm text-error-dark"
    >
      {children}
    </p>
  );
}
