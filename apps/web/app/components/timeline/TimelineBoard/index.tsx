"use client";

import type {
  TimelineItemView,
  TimelinePageView,
} from "@repo/core/application/memo/view";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  useActionState,
  useCallback,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { displayError } from "@/presentation/errorDisplay";
import { formatDay } from "@/presentation/time";
import { loadTimelinePageFn, postMemoFn } from "../actions";
import { type DisplayMemo, MemoEntry } from "../MemoEntry";
import { TIMELINE_PAGE_LIMIT } from "../schema";

type ComposerState = Readonly<{ error: string | null }>;

/** Newest first, ties broken by id — the order the repository promises. */
function byTimeline(a: TimelineItemView, b: TimelineItemView): number {
  return (
    b.postedAt.getTime() - a.postedAt.getTime() || b.id.localeCompare(a.id)
  );
}

/**
 * Merges the loader's page with the pages scrolled in since. The loader page
 * wins for a memo present in both, which is how the list re-bases onto the
 * refetched data after `router.invalidate()`.
 */
export function mergeTimeline(
  initial: readonly TimelineItemView[],
  loaded: readonly TimelineItemView[],
): TimelineItemView[] {
  const byId = new Map<string, TimelineItemView>();
  for (const memo of loaded) byId.set(memo.id, memo);
  for (const memo of initial) byId.set(memo.id, memo);
  return [...byId.values()].sort(byTimeline);
}

/** The date headings are display-only grouping (`spec/pages/index.md`, P-04). */
export function groupByDay(
  memos: readonly DisplayMemo[],
): ReadonlyArray<readonly [string, readonly DisplayMemo[]]> {
  const groups = new Map<string, DisplayMemo[]>();
  for (const memo of memos) {
    const day = formatDay(memo.postedAt);
    groups.set(day, [...(groups.get(day) ?? []), memo]);
  }
  return [...groups.entries()];
}

/**
 * The list owner: the client island seeded by the loader that runs the
 * membership-changing mutation (posting) with an optimistic entry, and pulls
 * older pages in as the sentinel scrolls into view.
 */
export function TimelineBoard({ initial }: { initial: TimelinePageView }) {
  const router = useRouter();
  const post = useServerFn(postMemoFn);
  const fetchPage = useServerFn(loadTimelinePageFn);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState<TimelineItemView[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const base = mergeTimeline(initial.items, loaded);
  const next = cursor === undefined ? initial.nextCursor : cursor;
  const [optimistic, addOptimistic] = useOptimistic<DisplayMemo[], DisplayMemo>(
    base,
    (current, memo) => [memo, ...current],
  );

  const loadNext = useCallback(() => {
    if (!next || busy.current) return;
    busy.current = true;
    startLoad(async () => {
      try {
        const result = await fetchPage({
          data: {
            cursor: next,
            direction: "older",
            limit: TIMELINE_PAGE_LIMIT,
          },
        });
        setLoaded((current) => mergeTimeline(current, result.items));
        setCursor(result.nextCursor);
        setLoadError(null);
      } catch (failure) {
        setLoadError(displayError(failure));
      } finally {
        busy.current = false;
      }
    });
  }, [next, fetchPage]);

  useEffect(() => {
    if (!next || loadError || loading || !sentinel.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadNext();
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [next, loadError, loading, loadNext]);

  const [state, action, pending] = useActionState<ComposerState, FormData>(
    async () => {
      const body = draft;
      if (body.trim().length === 0) {
        return { error: "メモを入力してください" };
      }
      const now = new Date();
      addOptimistic({
        id: `pending-${now.getTime()}`,
        body,
        postedAt: now,
        updatedAt: now,
        latestRevisionNumber: 1,
        version: 0,
        sourceDocuments: [],
        pending: true,
      });
      try {
        await post({ data: { body } });
        await router.invalidate();
        setDraft("");
        return { error: null };
      } catch (failure) {
        // The optimistic entry reverts with the transition; the draft stays.
        return { error: displayError(failure) };
      }
    },
    { error: null },
  );

  const groups = groupByDay(optimistic);
  return (
    <section
      className="fog-timeline"
      aria-label="メモ一覧"
      aria-busy={pending || loading}
    >
      {optimistic.length === 0 ? (
        <div className="fog-empty">
          <span className="fog-empty-mark" aria-hidden="true">
            ＋
          </span>
          <h2>最初のメモを残そう</h2>
          <p>
            思いつきも、今日の出来事も。下の入力欄から気軽に書き留めてください。
          </p>
        </div>
      ) : (
        groups.map(([day, entries]) => (
          <section className="fog-day" key={day}>
            <h2>{day}</h2>
            {entries.map((memo) => (
              <MemoEntry key={memo.id} memo={memo} />
            ))}
          </section>
        ))
      )}
      {loadError && (
        <p className="fog-error" role="alert">
          {loadError}
        </p>
      )}
      <div ref={sentinel} className="fog-load-more">
        {next && (
          <button
            type="button"
            className="fog-secondary"
            onClick={loadNext}
            disabled={loading}
          >
            {loading ? "読み込み中…" : "過去のメモを読み込む"}
          </button>
        )}
      </div>
      <div className="fog-composer-wrap">
        <form className="fog-composer" action={action} aria-label="メモを投稿">
          <label className="fog-sr-only" htmlFor="memo-composer">
            メモ
          </label>
          <textarea
            id="memo-composer"
            name="body"
            placeholder="いま思ったことを書く"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={pending}
            rows={2}
            maxLength={10_000}
          />
          <button
            className="fog-primary"
            type="submit"
            disabled={pending || draft.trim().length === 0}
          >
            {pending ? "投稿中…" : "投稿"}
          </button>
          {state.error && (
            <p className="fog-error" role="alert">
              {state.error}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
