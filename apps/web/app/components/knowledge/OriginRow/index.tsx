"use client";

import type { RelatedMemoView } from "@repo/core/application/knowledge/view";
import { Link } from "@tanstack/react-router";
import { formatDateTime } from "@/presentation/time";

function JumpIcon() {
  return (
    <span className="fog-origin-jump">
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
      >
        <path
          d="M5 15L15 5M15 5H7.5M15 5V12.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/**
 * One memo cited by a document — P-08's 「元になったメモ」 and P-07's 関連メモ.
 * A live memo links to its position on the timeline (`/?memo=`); a memo in
 * the trash reads 「削除済みのメモ」 and does not navigate. A hard-deleted
 * memo never reaches here (ADR-003).
 */
export function OriginRow({ memo }: { memo: RelatedMemoView }) {
  const time = (
    <span className="fog-origin-time">{formatDateTime(memo.postedAt)}</span>
  );
  if (memo.deleted) {
    return (
      <div className="fog-origin-row deleted" aria-disabled="true">
        <span className="fog-origin-main">
          {time}
          <span className="fog-origin-text">削除済みのメモ</span>
        </span>
        <JumpIcon />
      </div>
    );
  }
  return (
    <Link
      className="fog-origin-row"
      to="/"
      search={{ memo: memo.memoId }}
      aria-label={`タイムラインで表示: ${memo.snippet}`}
    >
      <span className="fog-origin-main">
        {time}
        <span className="fog-origin-text">{memo.snippet}</span>
      </span>
      <JumpIcon />
    </Link>
  );
}

/** The list of them, or nothing at all when there is none to show. */
export function OriginList({
  memos,
  label,
}: {
  memos: readonly RelatedMemoView[];
  label: string;
}) {
  if (memos.length === 0) return null;
  return (
    <section className="fog-origin" aria-label={label}>
      <h3 className="fog-section-label">{label}</h3>
      <div className="fog-origin-list">
        {memos.map((memo) => (
          <OriginRow key={memo.memoId} memo={memo} />
        ))}
      </div>
    </section>
  );
}
