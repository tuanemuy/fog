import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "children"
> & {
  variant?: "primary" | "outline";
  /** Disables the button and swaps in `pendingLabel` while a submit is in flight. */
  pending?: boolean;
  pendingLabel?: string;
  fullWidth?: boolean;
  children: ReactNode;
};

const BASE =
  "inline-flex cursor-pointer items-center justify-center gap-sm rounded-full p-(--pad-btn) text-base font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default";

const VARIANT = {
  primary:
    "bg-primary-dark text-text-inverse enabled:hover:bg-primary-darker enabled:active:bg-primary-darker disabled:bg-neutral-200 disabled:text-neutral-400",
  outline:
    "bg-transparent text-neutral-900 [border:var(--border-input)] enabled:hover:border-neutral-600 disabled:text-neutral-400",
} as const;

/** Pill button. `spec/design/pages/login.html` の `.btn` / `.btn-primary` / `.btn-outline`. */
export function Button({
  variant = "primary",
  pending = false,
  pendingLabel,
  fullWidth = false,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const label = pending && pendingLabel !== undefined ? pendingLabel : children;
  return (
    <button
      {...rest}
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
      className={`${BASE} ${VARIANT[variant]}${fullWidth ? " w-full" : ""}`}
    >
      {label}
    </button>
  );
}
