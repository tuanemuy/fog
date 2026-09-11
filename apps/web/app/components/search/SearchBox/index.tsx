import type { FormEvent } from "react";
import { Icon } from "@/components/ui/Icon";

export type SearchBoxProps = Readonly<{ defaultValue: string }> &
  (
    | Readonly<{
        onSubmit: (event: FormEvent<HTMLFormElement>) => void;
        loading?: never;
      }>
    | Readonly<{ loading: true; onSubmit?: never }>
  );

/**
 * The keyword box (`.search-box` in `spec/design/pages/search.html`): the
 * search glyph and the input on one pill, ringed while the input has focus.
 * There is no submit button — the input is the form's only field, so Enter
 * submits it. While the screen is loading the box is drawn with its input
 * disabled, so the swap to the loaded screen moves nothing.
 */
export function SearchBox({ defaultValue, onSubmit, loading }: SearchBoxProps) {
  return (
    <search>
      {/* The input inherits its font from here: the legacy unlayered
          `input { font: inherit }` outranks a font utility on the input. */}
      <form
        onSubmit={onSubmit}
        className="flex items-center gap-md rounded-full bg-neutral-50 p-(--pad-input) font-base text-base leading-tight text-neutral-500 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus"
      >
        <Icon name="search" size="md" />
        <input
          type="search"
          name="q"
          defaultValue={defaultValue}
          disabled={loading}
          placeholder="メモとドキュメントを検索…"
          aria-label="メモとドキュメントを検索"
          maxLength={500}
          autoComplete="off"
          enterKeyHint="search"
          className="min-w-[0] flex-1 bg-transparent text-neutral-900 outline-none placeholder:text-neutral-400"
        />
      </form>
    </search>
  );
}
