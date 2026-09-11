"use client";

import { type FormEvent, useEffect, useRef } from "react";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";

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
 * (`spec/design/pages/timeline.html`, `.filter-bar`): the search glyph, the
 * input (Enter filters), and, while a keyword is applied, the × that clears
 * it. The bare input draws no ring of its own; the bar rings while it has
 * keyboard focus. It carries the space under itself on its own
 * `next-sibling:` side, so the space goes away with the bar.
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
    <search id={id} className="next-sibling:mt-lg">
      <form
        onSubmit={submit}
        className="flex items-center gap-sm rounded-full bg-neutral-50 px-md py-sm has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus"
      >
        <span className="flex shrink-0 text-neutral-500">
          <Icon name="search" size="sm" />
        </span>
        <input
          ref={input}
          type="text"
          name="q"
          defaultValue={keyword ?? ""}
          placeholder="タイムラインを絞り込む…"
          aria-label="キーワードで絞り込む"
          maxLength={500}
          className="min-w-0 flex-1 bg-transparent font-base text-sm leading-tight text-neutral-900 outline-none placeholder:text-neutral-400"
        />
        {keyword === undefined ? null : (
          <IconButton
            icon="close"
            label="絞り込みを解除"
            size="sm"
            placement="row"
            onClick={onClear}
          />
        )}
      </form>
    </search>
  );
}
