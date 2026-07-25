import type { ReactNode, Ref } from "react";

/**
 * Form-level error banner (`spec/design/pages/login.html` の `.error-message`).
 *
 * `role="alert"` so the message is announced when it appears after a
 * failed submit. Field-scoped messages belong on `TextField` instead —
 * errors are shown where they can be acted on.
 *
 * `tabIndex={-1}` exists only so the form can move focus here: a form-level
 * failure names no field, and the submit button that had focus is disabled
 * while the request is in flight, which drops focus to `<body>`.
 */
export function FormMessage({
  ref,
  children,
}: {
  ref?: Ref<HTMLParagraphElement>;
  children: ReactNode;
}) {
  return (
    <p
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="rounded-md border border-error bg-error-bg p-(--pad-input) text-sm text-error-dark"
    >
      {children}
    </p>
  );
}
