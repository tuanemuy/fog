import { Icon } from "@/components/ui/Icon";

export type SearchLoadingProps = Readonly<{
  /** 検索中 where the results will be, 読み込み中 where 「もっと読む」 was. */
  label: "検索中" | "読み込み中";
}>;

/**
 * The spinner line that holds the place of what is loading
 * (`.loading-more` in `spec/design/pages/search.html`, the same form as
 * `timeline.html`'s), announced once as a status.
 */
export function SearchLoading({ label }: SearchLoadingProps) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-sm pt-lg pb-sm font-base text-xs font-medium leading-tight tracking-label text-neutral-400"
    >
      <Icon name="spinner" size="xs" />
      {label}
    </div>
  );
}
