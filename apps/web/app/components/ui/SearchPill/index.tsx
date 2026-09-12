import type {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  ReactNode,
  Ref,
} from "react";
import { Icon } from "@/components/ui/Icon";

/** The ceiling a keyword is typed against, the same wherever one is typed. */
const KEYWORD_MAX = 500;

const PILL_CLASS =
  "flex items-center gap-md rounded-full bg-neutral-50 p-(--pad-input) has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus";

const INPUT_CLASS =
  "min-w-[0] flex-1 bg-transparent font-base text-base leading-tight text-neutral-900 outline-none placeholder:text-neutral-400";

export type SearchPillProps = Readonly<{
  /** The input's accessible name: what typing in the pill searches. */
  label: string;
  placeholder: string;
  /**
   * `search` leaves the browser its own clear glyph; `text` is for a pill
   * that draws its own clear as the trailing control.
   */
  type: "search" | "text";
  /** The field's name in the form the pill submits, when it submits one. */
  name?: string | undefined;
  defaultValue?: string | undefined;
  value?: string | undefined;
  disabled?: boolean | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
  onChange?: ((event: ChangeEvent<HTMLInputElement>) => void) | undefined;
  onKeyDown?: ((event: KeyboardEvent<HTMLInputElement>) => void) | undefined;
  /**
   * Enter submits the pill as a form of its own. A pill inside another form
   * takes none — a form may not nest one — and answers Enter on `onKeyDown`.
   */
  onSubmit?: ((event: FormEvent<HTMLFormElement>) => void) | undefined;
  /** The landmark's id, for whatever opens and closes the pill. */
  id?: string | undefined;
  /** The control at the trailing end: a clear, a close, or nothing. */
  children?: ReactNode | undefined;
}>;

/**
 * The keyword pill every screen searches from (`.search-box` /
 * `.filter-bar` / `.picker-search` in `spec/design/pages/*.html`, one form
 * for all three): the search glyph and a borderless input on a filled pill,
 * ringed while the input has the focus — a trailing control keeps its own
 * ring and does not ring the pill. Where the pill sits and what space it
 * carries is the screen's; the look is the pill's alone.
 */
export function SearchPill({
  label,
  placeholder,
  type,
  name,
  defaultValue,
  value,
  disabled,
  ref,
  onChange,
  onKeyDown,
  onSubmit,
  id,
  children,
}: SearchPillProps) {
  const field = (
    <>
      <span className="flex shrink-0 text-neutral-500">
        <Icon name="search" size="sm" />
      </span>
      <input
        ref={ref}
        type={type}
        name={name}
        defaultValue={defaultValue}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        onChange={onChange}
        onKeyDown={onKeyDown}
        maxLength={KEYWORD_MAX}
        autoComplete="off"
        enterKeyHint="search"
        className={INPUT_CLASS}
      />
      {children}
    </>
  );
  return (
    <search id={id}>
      {onSubmit === undefined ? (
        <div className={PILL_CLASS}>{field}</div>
      ) : (
        <form onSubmit={onSubmit} className={PILL_CLASS}>
          {field}
        </form>
      )}
    </search>
  );
}
