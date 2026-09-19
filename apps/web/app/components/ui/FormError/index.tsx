import type { ReactNode } from "react";

export type FormErrorProps = Readonly<{
  /** A sentence, possibly with the one link that resolves it (「ログイン」). */
  children: ReactNode;
}>;

/**
 * The failure of a form as a whole — one that no single field owns (a
 * rejected login, a duplicate address, a lockout). It goes first in the
 * form, above the fields (`spec/design/pages/login.html`, `.error-message`).
 * A field's own failure is `FormGroup`'s `error`; a row's is `RowError`.
 */
export function FormError({ children }: FormErrorProps) {
  return (
    <div
      role="alert"
      className="rounded-md border border-error bg-error-bg p-md font-base text-sm leading-tight text-error-dark wrap-anywhere"
    >
      {children}
    </div>
  );
}
