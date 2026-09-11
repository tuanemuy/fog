"use client";

import type { RelatedMemoView } from "@repo/core/application/knowledge/view";
import { Icon } from "@/components/ui/Icon";
import { RowLink } from "@/components/ui/RowLink";
import { RowList } from "@/components/ui/RowList";
import { SheetSection } from "@/components/ui/SheetSection";
import { formatDateTime } from "@/presentation/time";

// `spec/design/pages/document.html`, `.time-label` / `.o-text`.
const TIME_CLASS =
  "block text-xs font-medium leading-tight tracking-label text-neutral-400 tabular-nums next-sibling:mt-xs";
const TEXT_CLASS = "line-clamp-2 leading-normal";

/**
 * One memo cited by a document — P-08's 「元になったメモ」 and P-07's 関連メモ.
 * A live memo is a `RowLink` to its position on the timeline (`/?memo=`); a
 * memo in the trash reads 「削除済みのメモ」, grayed, and does not navigate.
 * A hard-deleted memo never reaches here.
 */
export function OriginRow({ memo }: { memo: RelatedMemoView }) {
  const time = (
    <span className={TIME_CLASS}>{formatDateTime(memo.postedAt)}</span>
  );
  if (memo.deleted) {
    // Not interactive, so no hover surface and no bleed past the text
    // column: `RowLink`'s padding lands the text in the same place.
    return (
      <div
        aria-disabled="true"
        className="flex items-center gap-md py-row font-base text-base leading-normal text-neutral-400"
      >
        <span className="min-w-[0] flex-1">
          {time}
          <span className={`block ${TEXT_CLASS}`}>削除済みのメモ</span>
        </span>
        <span className="flex shrink-0 text-neutral-300">
          <Icon name="jump" size="md" />
        </span>
      </div>
    );
  }
  return (
    <RowLink
      to="/"
      search={{ memo: memo.memoId }}
      aria-label={`タイムラインで表示: ${memo.snippet}`}
    >
      {time}
      <span className={`block text-neutral-700 ${TEXT_CLASS}`}>
        {memo.snippet}
      </span>
    </RowLink>
  );
}

/** The list of them under its label, or nothing at all when there is none. */
export function OriginList({
  memos,
  label,
  level = 3,
}: {
  memos: readonly RelatedMemoView[];
  label: string;
  /** Heading level of the label under the page's `h1`. */
  level?: 2 | 3;
}) {
  if (memos.length === 0) return null;
  return (
    <SheetSection label={label} level={level}>
      <RowList>
        {memos.map((memo) => (
          <li key={memo.memoId}>
            <OriginRow memo={memo} />
          </li>
        ))}
      </RowList>
    </SheetSection>
  );
}
