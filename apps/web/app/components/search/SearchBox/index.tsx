import type { FormEvent } from "react";
import { SearchPill } from "@/components/ui/SearchPill";

export type SearchBoxProps = Readonly<{ defaultValue: string }> &
  (
    | Readonly<{
        onSubmit: (event: FormEvent<HTMLFormElement>) => void;
        loading?: never;
      }>
    | Readonly<{ loading: true; onSubmit?: never }>
  );

/**
 * The keyword box of the search screen (`.search-box` in
 * `spec/design/pages/search.html`): the shared pill, with no submit button —
 * the input is the form's only field, so Enter submits it. While the screen
 * is loading the box is drawn with its input disabled, so the swap to the
 * loaded screen moves nothing.
 */
export function SearchBox({ defaultValue, onSubmit, loading }: SearchBoxProps) {
  return (
    <SearchPill
      label="メモとドキュメントを検索"
      placeholder="メモとドキュメントを検索…"
      type="search"
      name="q"
      defaultValue={defaultValue}
      disabled={loading}
      onSubmit={onSubmit}
    />
  );
}
