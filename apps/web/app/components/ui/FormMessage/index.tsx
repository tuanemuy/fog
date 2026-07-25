import type { ReactNode, Ref } from "react";

/**
 * Form-level error banner (`spec/design/pages/login.html` の `.error-message`).
 *
 * `role="alert"` announces the message when it appears after a failed
 * submit; field-scoped messages belong on `TextField` instead.
 * `tabIndex={-1}` lets the form move focus here — a form-level failure
 * names no field, and the disabled submit button has dropped focus to
 * `<body>`.
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
