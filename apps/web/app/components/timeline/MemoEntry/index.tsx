"use client";

import type { TimelineItemView } from "@repo/core/application/memo/view";
import { formatTime } from "@/presentation/time";
import { Markdown } from "../Markdown";

export type DisplayMemo = TimelineItemView & { pending?: boolean };

/** One memo on the timeline. The edit / history / delete menu joins with the next slice. */
export function MemoEntry({ memo }: { memo: DisplayMemo }) {
  return (
    <article
      id={`memo-${memo.id}`}
      className={`fog-memo${memo.pending ? " fog-memo-pending" : ""}`}
      aria-busy={memo.pending ? true : undefined}
    >
      <div className="fog-memo-meta">
        <time dateTime={memo.postedAt.toISOString()}>
          {formatTime(memo.postedAt)}
        </time>
        {memo.pending && <span role="status">保存中…</span>}
      </div>
      <Markdown body={memo.body} />
    </article>
  );
}
