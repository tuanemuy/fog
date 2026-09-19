"use client";

import type { ComponentPropsWithRef } from "react";
import { FormGroup, type FormGroupProps } from "@/components/ui/FormGroup";
import { TEXT_AREA_CLASS } from "@/components/ui/TextField/styles";

type OwnedByGroup =
  | "className"
  | "style"
  | "children"
  | "id"
  | "aria-describedby"
  | "aria-invalid"
  | "aria-label"
  | "aria-labelledby";

export type TextAreaFieldProps = Omit<
  ComponentPropsWithRef<"textarea">,
  OwnedByGroup
> &
  Omit<FormGroupProps, "children">;

/**
 * `TextField`'s several-line twin — a description, a memo being edited:
 * the same group and wiring around a textarea that starts two lines tall and
 * grows with what is typed. `rows` is the height where the browser cannot
 * size a field by its content.
 */
export function TextAreaField({
  label,
  hideLabel,
  helper,
  error,
  ...rest
}: TextAreaFieldProps) {
  return (
    <FormGroup
      label={label}
      hideLabel={hideLabel}
      helper={helper}
      error={error}
    >
      {(control) => (
        <textarea
          {...rest}
          {...control}
          className={TEXT_AREA_CLASS}
          style={undefined}
        />
      )}
    </FormGroup>
  );
}
