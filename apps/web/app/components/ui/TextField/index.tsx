import type { Ref } from "react";

type TextFieldProps = {
  id: string;
  name: string;
  label: string;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  placeholder?: string;
  helperText?: string;
  /** Field-scoped error. Wires `aria-invalid` and `aria-describedby` when set. */
  error?: string;
  defaultValue?: string;
  required?: boolean;
  disabled?: boolean;
  maxLength?: number;
  /** Lets a form move focus here after a failed submit. */
  inputRef?: Ref<HTMLInputElement>;
};

// The mock's `.form-input:focus { outline: none }` is deliberately not
// translated: Tailwind's outline-none utility sets `--tw-outline-style: none`,
// which the outline-2 utility then reads, so the focus-visible ring would
// never paint. Modern browsers only draw the UA outline on :focus-visible
// anyway, so dropping it is equivalent.
const INPUT =
  "rounded-md [border:var(--border-input)] bg-bg-card p-(--pad-input) font-base text-base text-neutral-900 transition-colors placeholder:text-neutral-400 focus:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-[invalid=true]:border-error";

/**
 * Label + input + optional helper / error, matching `.form-group` in
 * `spec/design/pages/login.html` and `signup.html`.
 */
export function TextField({
  id,
  name,
  label,
  type = "text",
  autoComplete,
  placeholder,
  helperText,
  error,
  defaultValue,
  required,
  disabled,
  maxLength,
  inputRef,
}: TextFieldProps) {
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const describedBy = [
    helperText !== undefined ? helperId : null,
    error !== undefined ? errorId : null,
  ]
    .filter((value) => value !== null)
    .join(" ");

  return (
    <div className="flex flex-col gap-sm">
      <div>
        <label className="text-sm font-medium text-neutral-900" htmlFor={id}>
          {label}
        </label>
        {helperText !== undefined ? (
          <span
            id={helperId}
            className="mt-xs block text-sm font-regular text-neutral-600"
          >
            {helperText}
          </span>
        ) : null}
      </div>
      <input
        id={id}
        name={name}
        type={type}
        className={INPUT}
        {...(inputRef !== undefined ? { ref: inputRef } : {})}
        {...(autoComplete !== undefined ? { autoComplete } : {})}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(defaultValue !== undefined ? { defaultValue } : {})}
        {...(maxLength !== undefined ? { maxLength } : {})}
        {...(required === true ? { required: true } : {})}
        {...(disabled === true ? { disabled: true } : {})}
        aria-invalid={error !== undefined}
        {...(describedBy.length > 0 ? { "aria-describedby": describedBy } : {})}
      />
      {error !== undefined ? (
        <p id={errorId} aria-live="polite" className="text-sm text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
