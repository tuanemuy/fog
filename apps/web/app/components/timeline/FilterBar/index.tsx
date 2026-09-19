"use client";

import { type FormEvent, useEffect, useRef } from "react";
import { IconButton } from "@/components/ui/IconButton";
import { SearchPill } from "@/components/ui/SearchPill";

export type FilterBarProps = Readonly<{
  id: string;
  /** The keyword the timeline is filtered by now, if any. */
  keyword: string | undefined;
  /** Take focus when drawn — the bar was just opened from the header. */
  focusOnOpen: boolean;
  onFilter: (keyword: string) => void;
  onClear: () => void;
}>;

/**
 * The keyword bar at the top of the sheet, opened from the header's search
 * (`spec/design/pages/timeline.html`, `.filter-bar`): the shared pill (Enter
 * filters) and, while a keyword is applied, the × that clears it. It carries
 * the space under itself on its own `next-sibling:` side, so the space goes
 * away with the bar.
 */
export function FilterBar({
  id,
  keyword,
  focusOnOpen,
  onFilter,
  onClear,
}: FilterBarProps) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusOnOpen) input.current?.focus();
  }, [focusOnOpen]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onFilter(String(new FormData(event.currentTarget).get("q") ?? "").trim());
  };

  return (
    <div className="next-sibling:mt-lg">
      <SearchPill
        id={id}
        label="キーワードで絞り込む"
        placeholder="タイムラインを絞り込む…"
        type="text"
        name="q"
        defaultValue={keyword ?? ""}
        ref={input}
        onSubmit={submit}
      >
        {keyword === undefined ? null : (
          <IconButton
            icon="close"
            label="絞り込みを解除"
            size="sm"
            placement="row"
            onClick={onClear}
          />
        )}
      </SearchPill>
    </div>
  );
}
