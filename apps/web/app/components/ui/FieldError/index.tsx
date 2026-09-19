export type FieldErrorProps = Readonly<{
  /** Referenced by the control's `aria-describedby`; required so it can be. */
  id: string;
  children: string;
}>;

/**
 * The failure of one field, right under it (`spec/design/pages/signup.html`,
 * `.field-error`). `FormGroup` draws it for its own control; a field laid out
 * some other way (a number input in a settings row, the document title) puts
 * it under the control itself and points `aria-describedby` / `aria-invalid`
 * at it. `role="alert"` announces it when a submit turns it up.
 */
export function FieldError({ id, children }: FieldErrorProps) {
  return (
    <p
      id={id}
      role="alert"
      className="font-base text-sm leading-tight text-error wrap-anywhere"
    >
      {children}
    </p>
  );
}
