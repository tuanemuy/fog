import type { ComponentPropsWithRef } from "react";
import { type ButtonVariant, buttonClassName } from "./styles";

export type { ButtonVariant } from "./styles";

export type ButtonProps = Omit<
  ComponentPropsWithRef<"button">,
  "className" | "style"
> &
  Readonly<{ variant: ButtonVariant }>;

/**
 * A text button in one of the base forms' steps (`ButtonVariant`).
 *
 * The look is the step and nothing else: `className` and `style` are not
 * accepted (and are overwritten if forced through), so a screen places the
 * button from a wrapper and never restyles it. `type` defaults to `"button"`; a form's submit says so. The link-shaped
 * twin is `ButtonLink`.
 */
export function Button({ variant, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={buttonClassName(variant)}
      style={undefined}
    />
  );
}
