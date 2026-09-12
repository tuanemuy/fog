"use client";

import {
  type ComponentPropsWithRef,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";

export type DialogProps = Readonly<{
  /** Names the dialog, and is drawn as its heading. */
  title: string;
  /** One sentence under the title. */
  description?: string;
  /** Escape and a press on the backdrop reach this; so does the cancel. */
  onClose: () => void;
  /**
   * While what the dialog started is in flight, neither the backdrop nor
   * Escape closes it.
   */
  locked?: boolean;
  /** The body between the sentence and the controls. */
  children: ReactNode;
}>;

// The dialog's own controls (`.dialog-confirm` / `.dialog-cancel` in
// `spec/design/pages/trash.html`). A non-destructive confirmation is the
// `fill-sm` step as it is; these two exist only here, so they are not steps
// of `Button`.
const DIALOG_BUTTON =
  "inline-flex cursor-pointer items-center justify-center rounded-full p-(--pad-btn-sm) font-base text-sm font-medium leading-tight [border:var(--border-input)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:text-neutral-300";
const DANGER_CLASS = `${DIALOG_BUTTON} bg-bg-card text-error focus-visible:outline-focus-danger not-disabled:hover:bg-error-bg`;
const CANCEL_CLASS = `${DIALOG_BUTTON} bg-transparent text-neutral-600 focus-visible:outline-focus not-disabled:hover:bg-neutral-50`;

type DialogButtonProps = Omit<
  ComponentPropsWithRef<"button">,
  "className" | "style"
>;

/** The destructive confirmation of a dialog. */
export function DialogDangerButton({
  type = "button",
  ...rest
}: DialogButtonProps) {
  return (
    <button {...rest} type={type} className={DANGER_CLASS} style={undefined} />
  );
}

/** The cancel of a dialog, whatever closes it. */
export function DialogCancelButton({
  type = "button",
  ...rest
}: DialogButtonProps) {
  return (
    <button {...rest} type={type} className={CANCEL_CLASS} style={undefined} />
  );
}

/** The dialog's controls, stacked full width at the foot of the card. */
export function DialogActions({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="mt-xl flex flex-col gap-sm">{children}</div>;
}

/**
 * A native modal `<dialog>` in the shape of `.dialog-box`
 * (`spec/design/pages/trash.html`): the card, its title and one sentence,
 * then whatever the caller puts under them — the two buttons of a
 * confirmation (`ConfirmDialog`), or a form (the trash's restore
 * destination). `showModal()` runs on mount, so the caller mounts it only
 * while it is open; Escape and backdrop presses reach `onClose` through the
 * element's own `close` event.
 *
 * While `locked`, Escape is refused on the `cancel` event rather than
 * swallowed after the fact: the element would otherwise close itself while
 * the caller kept it mounted, and a mounted element is never shown again.
 */
export function Dialog({
  title,
  description,
  onClose,
  locked = false,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // jsdom has no `showModal`; the attribute keeps the element visible there.
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);

  return (
    // The click only detects a hit on the backdrop, which is the `<dialog>`
    // itself around the box — hence the box inside it rather than on it. The
    // keyboard path to the same cancel is the native Escape, through `onClose`.
    // `m-auto` puts the modal back in the middle of the viewport: the
    // preflight's blanket `margin: 0` otherwise pins it to the top left.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <dialog
      ref={ref}
      className="m-auto w-sheet max-w-narrow bg-transparent backdrop:bg-overlay"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (locked) event.preventDefault();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <div className="rounded-lg bg-bg-card px-xl py-2xl font-base shadow-md">
        <h2
          id={titleId}
          className="text-lg font-semibold leading-tight text-neutral-900"
        >
          {title}
        </h2>
        {description === undefined ? null : (
          <p className="mt-md text-sm leading-normal text-neutral-700">
            {description}
          </p>
        )}
        {children}
      </div>
    </dialog>
  );
}
