"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/Button";
import { FormGroup } from "@/components/ui/FormGroup";
import { IconButton } from "@/components/ui/IconButton";

export type DateJumpProps = Readonly<{
  /** The day the timeline stands on now, as `YYYY-MM-DD`. */
  date: string | undefined;
  onJump: (date: string) => void;
}>;

// `.date-input` in `spec/design/pages/timeline.html`; the box is tokens.md's
// `--pad-input`, the ring the form fields' outer one.
const DATE_INPUT_CLASS =
  "min-w-0 rounded-md bg-bg-card p-(--pad-input) font-base text-base leading-tight tabular-nums text-neutral-900 [border:var(--border-input)] transition-colors focus:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * The header's calendar and the card it opens under itself
 * (`spec/design/pages/timeline.html`, `.date-pop`): a date and 「移動」.
 * Opening moves focus to the date; Escape closes and returns focus to the
 * calendar, and a press outside closes it.
 */
export function DateJump({ date, onJump }: DateJumpProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cardId = useId();

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setOpen(false);
    trigger.current?.focus();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const picked = String(new FormData(event.currentTarget).get("date") ?? "");
    if (picked.length === 0) return;
    setOpen(false);
    onJump(picked);
  };

  return (
    <div ref={wrap} className="relative inline-flex">
      <IconButton
        ref={trigger}
        icon="calendar"
        label="日付を指定して移動"
        size="md"
        placement="header"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        onClick={() => setOpen(!open)}
      />
      {open ? (
        <div
          id={cardId}
          role="dialog"
          aria-label="日付を指定して移動"
          onKeyDown={onKeyDown}
          className="absolute top-full right-[0] z-15 mt-xs rounded-popover bg-bg-card p-md shadow-md"
        >
          <form onSubmit={submit}>
            <FormGroup label="日付を指定して移動">
              {(control) => (
                <div className="flex items-center gap-sm">
                  <input
                    {...control}
                    ref={input}
                    type="date"
                    name="date"
                    required
                    defaultValue={date ?? ""}
                    className={DATE_INPUT_CLASS}
                  />
                  <Button variant="fill-sm" type="submit">
                    移動
                  </Button>
                </div>
              )}
            </FormGroup>
          </form>
        </div>
      ) : null}
    </div>
  );
}
