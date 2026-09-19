import { formatDateTime } from "@/presentation/time";

export type SourceMemoLineProps = Readonly<{
  postedAt: Date;
  snippet: string;
  /** A memo in the trash: its text is withheld (P-08 「削除済みのメモ」). */
  deleted?: boolean;
}>;

/**
 * A memo as the editor lists it among the sources or the search candidates
 * (`spec/design/pages/document-edit.html`, `.origin-row .row-main`): the
 * posting time over at most two lines of its text. It goes in a `Row`, whose
 * controls (remove, add) sit beside it.
 */
export function SourceMemoLine({
  postedAt,
  snippet,
  deleted = false,
}: SourceMemoLineProps) {
  return (
    <>
      <span className="block font-base text-xs font-medium leading-tight tracking-label text-neutral-400 tabular-nums next-sibling:mt-xs">
        {formatDateTime(postedAt)}
      </span>
      <span
        className={`line-clamp-2 font-base text-base leading-normal ${deleted ? "text-neutral-400" : "text-neutral-700"}`}
      >
        {deleted ? "削除済みのメモ" : snippet}
      </span>
    </>
  );
}
