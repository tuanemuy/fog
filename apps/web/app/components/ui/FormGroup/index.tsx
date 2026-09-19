"use client";

import { type ReactNode, useId } from "react";
import { FieldError } from "@/components/ui/FieldError";

/** What a control inside a `FormGroup` spreads onto itself. */
export type FieldControlProps = Readonly<{
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}>;

export type FormGroupProps = Readonly<{
  /** The visible label — or, with `hideLabel`, the accessible name only. */
  label: string;
  /** For a field whose purpose shows without it (a placeholder-led inline form). */
  hideLabel?: boolean | undefined;
  /** The requirement shown under the label (「8文字以上」). */
  helper?: string | undefined;
  /** The field's own failure; it turns the control invalid and describes it. */
  error?: string | null | undefined;
  children: (control: FieldControlProps) => ReactNode;
}>;

const LABEL_CLASS =
  "font-base text-sm font-medium leading-tight text-neutral-900";
const HELPER_CLASS =
  "font-base text-sm font-regular leading-tight text-neutral-600";

/**
 * One field of a form (`spec/design/pages/login.html`, `.form-group`): label,
 * the requirement under it, the control, and the field's error under the
 * control. The group owns the ids, so the wiring cannot be half done: the
 * control is drawn by `children`, which receives the `id` the label points at
 * and the `aria-describedby` / `aria-invalid` that name the error and the
 * helper. `TextField` / `TextAreaField` are this group around the two text
 * controls; anything else (a select, a number with its unit) goes in here.
 */
export function FormGroup({
  label,
  hideLabel = false,
  helper,
  error,
  children,
}: FormGroupProps) {
  const id = useId();
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const hasHelper = helper !== undefined && helper !== "";
  const hasError = error !== undefined && error !== null && error !== "";
  const describedBy =
    [hasError ? errorId : null, hasHelper ? helperId : null]
      .filter((part) => part !== null)
      .join(" ") || undefined;
  const helperText = hasHelper ? (
    <p id={helperId} className={HELPER_CLASS}>
      {helper}
    </p>
  ) : null;
  return (
    <div className="flex flex-col gap-sm">
      {hideLabel ? (
        <>
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
          {helperText}
        </>
      ) : (
        <div className="flex flex-col items-start gap-xs">
          <label htmlFor={id} className={LABEL_CLASS}>
            {label}
          </label>
          {helperText}
        </div>
      )}
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": hasError ? true : undefined,
      })}
      {hasError ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
