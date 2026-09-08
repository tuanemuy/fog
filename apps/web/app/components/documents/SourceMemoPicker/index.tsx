"use client";

import type { TimelineItemView } from "@repo/core/application/memo/view";
import { snippetOf } from "@repo/core/lib/text";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { loadTimelinePageFn } from "@/components/timeline/actions";
import { isTimelinePageResult } from "@/components/timeline/schema";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatDateTime } from "@/presentation/time";

/** A memo chosen as a source, as the editor keeps it until the save. */
export type PickedMemo = Readonly<{
  memoId: string;
  snippet: string;
  postedAt: Date;
}>;

/** How many candidates one search shows (decision △-2). */
export const PICKER_PAGE_LIMIT = 20;

/**
 * P-09's source-memo picker: the timeline's keyword filter re-used as the
 * search (decision △-2 — a substring match over the user's own memos, the
 * most recent 20 when the box is empty). Only active memos come back, so
 * the trash never offers itself as a source.
 */
export function SourceMemoPicker({
  picked,
  onPick,
}: {
  picked: readonly PickedMemo[];
  onPick: (memo: PickedMemo) => void;
}) {
  const fetchPage = useServerFn(loadTimelinePageFn);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<TimelineItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const pickedIds = new Set(picked.map((memo) => memo.memoId));

  // Not a <form>: the picker sits inside the editor's form, and a form may
  // not nest another.
  const search = () => {
    const keyword = query.trim();
    startSearch(async () => {
      try {
        const page = readServerFnResult(
          await fetchPage({
            data: {
              cursor: null,
              direction: "older",
              limit: PICKER_PAGE_LIMIT,
              keyword: keyword.length > 0 ? keyword : null,
            },
          }),
          isTimelinePageResult,
          "loadTimelinePageFn",
        );
        setCandidates([...page.items]);
        setError(null);
      } catch (failure) {
        setError(displayError(failure));
      }
    });
  };

  return (
    <section className="fog-source-picker" aria-label="出典を追加">
      <h3>出典を追加</h3>
      <search className="fog-source-search">
        <label className="fog-sr-only" htmlFor="source-memo-query">
          メモを検索
        </label>
        <input
          id="source-memo-query"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="メモを検索（空欄で直近のメモ）"
          maxLength={500}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              search();
            }
          }}
        />
        <button
          type="button"
          className="fog-secondary"
          disabled={searching}
          onClick={search}
        >
          {searching ? "検索中…" : "検索"}
        </button>
      </search>
      {error && (
        <p className="fog-error" role="alert">
          {error}
        </p>
      )}
      {candidates !== null &&
        (candidates.length === 0 ? (
          <p className="fog-empty-inline">一致するメモはありません</p>
        ) : (
          <ul className="fog-source-candidates" aria-label="候補のメモ">
            {candidates.map((memo) => {
              const added = pickedIds.has(memo.id);
              return (
                <li key={memo.id} className="fog-source-option">
                  <span>
                    <span className="fog-meta">
                      {formatDateTime(memo.postedAt)}
                    </span>
                    <span className="fog-source-text">
                      {snippetOf(memo.body)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="fog-secondary"
                    disabled={added}
                    onClick={() =>
                      onPick({
                        memoId: memo.id,
                        snippet: snippetOf(memo.body),
                        postedAt: memo.postedAt,
                      })
                    }
                  >
                    {added ? "追加済み" : "追加"}
                  </button>
                </li>
              );
            })}
          </ul>
        ))}
    </section>
  );
}
