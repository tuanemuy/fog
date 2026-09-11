"use client";

import type { ComponentPropsWithRef } from "react";
import { FormGroup, type FormGroupProps } from "@/components/ui/FormGroup";
import { TEXT_INPUT_CLASS } from "./styles";

/** The text-entry types. A number or a date has a box of its own. */
export type TextFieldType = "text" | "email" | "password" | "search" | "url";

// What the group decides — the id, the description, the invalid state and the
// accessible name — is not taken from the caller, so none of it can disagree
// with the label and the error the group draws.
type OwnedByGroup =
  | "className"
  | "style"
  | "children"
  | "id"
  | "type"
  | "aria-describedby"
  | "aria-invalid"
  | "aria-label"
  | "aria-labelledby";

export type TextFieldProps = Omit<
  ComponentPropsWithRef<"input">,
  OwnedByGroup
> &
  Omit<FormGroupProps, "children"> &
  Readonly<{ type?: TextFieldType }>;

/**
 * A one-line text field: `FormGroup` around the form's input box. The label
 * names the input, `helper` and `error` describe it, and `error` also marks
 * it invalid — so a screen hands over strings, never ids. `className` and
 * `style` are not accepted; the native input props (`name`, `value`,
 * `autoComplete`, `disabled`, …) pass through.
 */
export function TextField({
  label,
  hideLabel,
  helper,
  error,
  type = "text",
  ...rest
}: TextFieldProps) {
  return (
    <FormGroup
      label={label}
      hideLabel={hideLabel}
      helper={helper}
      error={error}
    >
      {(control) => (
        <input
          {...rest}
          {...control}
          type={type}
          className={TEXT_INPUT_CLASS}
          style={undefined}
        />
      )}
    </FormGroup>
  );
}
