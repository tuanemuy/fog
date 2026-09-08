"use client";

import type {
  MemoTargetState,
  MemoView,
  TimelineItemView,
  TimelineWindowView,
} from "@repo/core/application/memo/view";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  type FormEvent,
  useActionState,
  useCallback,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import {
  calendarDateOf,
  formatCalendarDate,
  formatDay,
} from "@/presentation/time";
import { loadTimelinePageFn, postMemoFn, softDeleteMemoFn } from "../actions";
import { type DisplayMemo, MemoEntry } from "../MemoEntry";
import {
  isPostMemoResult,
  isSoftDeleteMemoResult,
  isTimelinePageResult,
  TIMELINE_PAGE_LIMIT,
} from "../schema";
import { compactSearch, type TimelineSearch, timelineModeOf } from "../search";

export type TimelineTarget = Readonly<{
  memoId: string;
  state: MemoTargetState;
}>;

/** What the loader seeds the board with: a window plus, for `?memo=`, where the target stands. */
export type TimelineBoardInitial = TimelineWindowView &
  Readonly<{ target: TimelineTarget | null }>;

type ComposerState = Readonly<{ error: string | null }>;

type ListAction =
  | Readonly<{ kind: "add"; memo: DisplayMemo }>
  | Readonly<{ kind: "remove"; id: string }>;

type Direction = "older" | "newer";

/** Newest first, ties broken by id — the order the repository promises. */
function byTimeline(a: TimelineItemView, b: TimelineItemView): number {
  return (
    b.postedAt.getTime() - a.postedAt.getTime() || b.id.localeCompare(a.id)
  );
}

/**
 * Merges the loader's window with the pages scrolled in since and the
 * in-item saves reported by the leaves. For a memo present twice the
 * higher `version` wins — `version` only ever grows, so that is the
 * re-base rule for both a refetched loader page and an edit that landed
 * before the refetch — and the loader page wins a tie.
 */
export function mergeTimeline(
  initial: readonly TimelineItemView[],
  loaded: readonly TimelineItemView[],
): TimelineItemView[] {
  const byId = new Map<string, TimelineItemView>();
  for (const memo of loaded) byId.set(memo.id, memo);
  for (const memo of initial) {
    const known = byId.get(memo.id);
    if (known === undefined || known.version <= memo.version) {
      byId.set(memo.id, memo);
    }
  }
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

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 20 20"
      fill="none"
    >
      <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M13.5 13.5L17 17"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      aria-hidden="true"
      width="19"
      height="19"
      viewBox="0 0 20 20"
      fill="none"
    >
      <rect
        x="3"
        y="4.5"
        width="14"
        height="12"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M3 8.5H17M7 2.8V6M13 2.8V6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The list owner: the client island seeded by the loader that runs the
 * membership-changing mutations (posting with an optimistic entry, deleting
 * with an optimistic removal), pulls pages in from both sentinels, and
 * carries the filter / jump / position state the URL expresses.
 */
export function TimelineBoard({
  initial,
  search,
}: {
  initial: TimelineBoardInitial;
  search: TimelineSearch;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const post = useServerFn(postMemoFn);
  const fetchPage = useServerFn(loadTimelinePageFn);
  const softDelete = useServerFn(softDeleteMemoFn);
  const mode = timelineModeOf(search);
  const keyword = mode.kind === "memo" ? null : mode.keyword;
  const plainList = mode.kind === "list" && keyword === null;

  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState<TimelineItemView[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [cursors, setCursors] = useState<{
    older: string | null | undefined;
    newer: string | null | undefined;
  }>({ older: undefined, newer: undefined });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingOlder, startOlder] = useTransition();
  const [loadingNewer, startNewer] = useTransition();
  const busy = useRef<Record<Direction, boolean>>({
    older: false,
    newer: false,
  });
  const olderSentinel = useRef<HTMLDivElement>(null);
  const newerSentinel = useRef<HTMLDivElement>(null);
  const [filterOpen, setFilterOpen] = useState(search.q !== undefined);
  const [dateOpen, setDateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DisplayMemo | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<{
    memo: DisplayMemo;
    message: string;
  } | null>(null);
  const [deleting, startDelete] = useTransition();

  const olderCursor =
    cursors.older === undefined ? initial.olderCursor : cursors.older;
  const newerCursor =
    cursors.newer === undefined ? initial.newerCursor : cursors.newer;

  const base = mergeTimeline(initial.items, loaded).filter(
    (memo) => !removed.has(memo.id),
  );
  const [optimistic, dispatch] = useOptimistic<DisplayMemo[], ListAction>(
    base,
    (current, action) =>
      action.kind === "add"
        ? [action.memo, ...current]
        : current.filter((memo) => memo.id !== action.id),
  );

  const goto = (next: TimelineSearch) =>
    navigate({ to: "/", search: compactSearch(next) });

  const loadMore = useCallback(
    (direction: Direction) => {
      const cursor = direction === "older" ? olderCursor : newerCursor;
      if (!cursor || busy.current[direction]) return;
      busy.current[direction] = true;
      const start = direction === "older" ? startOlder : startNewer;
      start(async () => {
        try {
          const result = readServerFnResult(
            await fetchPage({
              data: { cursor, direction, limit: TIMELINE_PAGE_LIMIT, keyword },
            }),
            isTimelinePageResult,
            "loadTimelinePageFn",
          );
          setLoaded((current) => mergeTimeline(current, result.items));
          setCursors((current) => ({
            ...current,
            [direction]: result.nextCursor,
          }));
          setLoadError(null);
        } catch (failure) {
          setLoadError(displayError(failure));
        } finally {
          busy.current[direction] = false;
        }
      });
    },
    [olderCursor, newerCursor, fetchPage, keyword],
  );

  useEffect(() => {
    if (loadError) return;
    const watched: [Element, Direction][] = [];
    if (olderCursor && !loadingOlder && olderSentinel.current) {
      watched.push([olderSentinel.current, "older"]);
    }
    if (newerCursor && !loadingNewer && newerSentinel.current) {
      watched.push([newerSentinel.current, "newer"]);
    }
    if (watched.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const hit = watched.find(([element]) => element === entry.target);
          if (hit) loadMore(hit[1]);
        }
      },
      { rootMargin: "200px" },
    );
    for (const [element] of watched) observer.observe(element);
    return () => observer.disconnect();
  }, [
    olderCursor,
    newerCursor,
    loadError,
    loadingOlder,
    loadingNewer,
    loadMore,
  ]);

  // A position-specified visit: bring the target into view once it is drawn.
  const target = initial.target;
  useEffect(() => {
    if (target?.state !== "found") return;
    const element = document.getElementById(`memo-${target.memoId}`);
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "center" });
    }
  }, [target]);

  // A date jump: start the viewport at the memo the day resolved to. When
  // that memo heads its day group the group scrolls, so the day heading is
  // what the reader sees first; otherwise the memo row itself does.
  const pivotId = mode.kind === "date" ? initial.pivotId : null;
  useEffect(() => {
    if (pivotId === null) return;
    const element = document.getElementById(`memo-${pivotId}`);
    if (!element || typeof element.scrollIntoView !== "function") return;
    const group = element.closest(".fog-day");
    const headsGroup = group?.querySelector("article") === element;
    (headsGroup && group ? group : element).scrollIntoView({ block: "start" });
  }, [pivotId]);

  // One post per submit event. Two submits dispatched in the same frame
  // (`requestSubmit()` twice, Enter and a click) both arrive before the
  // pending state disables the controls; the second one is stopped here,
  // before React queues its action, so it neither re-posts after a success
  // nor re-sends the same body after a failure.
  const inFlight = useRef(false);
  const guardSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (inFlight.current) event.preventDefault();
  };

  const [state, action, pending] = useActionState<ComposerState, FormData>(
    async (previous, formData) => {
      const body = String(formData.get("body") ?? "");
      if (body.trim().length === 0) return previous;
      inFlight.current = true;
      const now = new Date();
      dispatch({
        kind: "add",
        memo: {
          id: `pending-${now.getTime()}`,
          body,
          postedAt: now,
          updatedAt: now,
          latestRevisionNumber: 1,
          version: 0,
          sourceDocuments: [],
          pending: true,
        },
      });
      try {
        readServerFnResult(
          await post({ data: { body } }),
          isPostMemoResult,
          "postMemoFn",
        );
        setDraft("");
        // A new memo lives at the head of the plain timeline; a filtered
        // or repositioned window would not contain it.
        if (plainList) await router.invalidate();
        else await goto({});
        return { error: null };
      } catch (failure) {
        // The optimistic entry reverts with the transition; the draft stays.
        return { error: displayError(failure) };
      } finally {
        inFlight.current = false;
      }
    },
    { error: null },
  );

  const runDelete = (memo: DisplayMemo) => {
    setDeleteFailure(null);
    startDelete(async () => {
      dispatch({ kind: "remove", id: memo.id });
      try {
        readServerFnResult(
          await softDelete({ data: { memoId: memo.id } }),
          isSoftDeleteMemoResult,
          "softDeleteMemoFn",
        );
        // Keep it out of the list across the optimistic revert and until
        // the refetched window no longer carries it.
        setRemoved((current) => new Set(current).add(memo.id));
        setLoaded((current) => current.filter((item) => item.id !== memo.id));
        setDeleteTarget(null);
        await router.invalidate();
      } catch (failure) {
        setDeleteTarget(null);
        setDeleteFailure({ memo, message: displayError(failure) });
      }
    });
  };

  const onSaved = (memo: MemoView) =>
    setLoaded((current) => {
      const known =
        current.find((item) => item.id === memo.id) ??
        initial.items.find((item) => item.id === memo.id);
      return mergeTimeline(current, [
        { ...memo, sourceDocuments: known?.sourceDocuments ?? [] },
      ]);
    });

  const submitFilter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = String(new FormData(event.currentTarget).get("q") ?? "").trim();
    void goto(q.length > 0 ? { q, date: search.date } : { date: search.date });
  };

  const submitDate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const date = String(new FormData(event.currentTarget).get("date") ?? "");
    if (date.length === 0) return;
    setDateOpen(false);
    void goto({ date, q: search.q });
  };

  const notice = (() => {
    if (mode.kind === "memo" && target !== null) {
      if (target.state === "notFound") {
        return "指定されたメモは見つかりません。通常のタイムラインを表示しています";
      }
      if (target.state === "trashed") {
        return "指定されたメモはゴミ箱にあります。通常のタイムラインを表示しています";
      }
      return null;
    }
    if (mode.kind === "date" && optimistic.length > 0) {
      const label = formatCalendarDate(mode.date);
      const onTheDay = initial.items.some(
        (memo) => calendarDateOf(memo.postedAt) === mode.date,
      );
      return onTheDay
        ? `${label}に移動しました`
        : `${label}にメモはありません。前後で最も近いメモの位置を表示しています`;
    }
    return null;
  })();

  const groups = groupByDay(optimistic);
  return (
    <section
      className="fog-timeline"
      aria-label="メモ一覧"
      aria-busy={pending || loadingOlder || loadingNewer || deleting}
    >
      <div className="fog-toolbar">
        <button
          type="button"
          className="fog-icon-btn"
          aria-label="キーワードで絞り込む"
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((open) => !open)}
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          className="fog-icon-btn"
          aria-label="日付を指定して移動"
          aria-expanded={dateOpen}
          onClick={() => setDateOpen((open) => !open)}
        >
          <CalendarIcon />
        </button>
      </div>
      {filterOpen && (
        <search>
          <form className="fog-filter-bar" onSubmit={submitFilter}>
            <SearchIcon />
            <input
              type="text"
              name="q"
              defaultValue={search.q ?? ""}
              placeholder="タイムラインを絞り込む…"
              aria-label="キーワードで絞り込む"
              maxLength={500}
            />
            <button type="submit" className="fog-secondary">
              絞り込む
            </button>
            {search.q !== undefined && (
              <button
                type="button"
                className="fog-filter-clear"
                aria-label="絞り込みを解除"
                onClick={() => void goto({ date: search.date })}
              >
                ×
              </button>
            )}
          </form>
        </search>
      )}
      {dateOpen && (
        <form
          className="fog-date-jump"
          aria-label="日付を指定して移動"
          onSubmit={submitDate}
        >
          <label htmlFor="timeline-jump-date">日付</label>
          <input
            id="timeline-jump-date"
            type="date"
            name="date"
            required
            defaultValue={search.date ?? ""}
          />
          <button type="submit" className="fog-secondary">
            移動
          </button>
        </form>
      )}
      {notice && (
        <p className="fog-notice" role="status">
          {notice}
          {mode.kind === "date" && (
            <button
              type="button"
              className="fog-text-button"
              onClick={() => void goto({ q: search.q })}
            >
              先頭に戻る
            </button>
          )}
        </p>
      )}
      {deleteFailure && (
        <p className="fog-error" role="alert">
          {deleteFailure.message}
          <button
            type="button"
            className="fog-text-button"
            onClick={() => runDelete(deleteFailure.memo)}
          >
            再試行
          </button>
        </p>
      )}
      {newerCursor && (
        <div ref={newerSentinel} className="fog-load-more">
          <button
            type="button"
            className="fog-secondary"
            onClick={() => loadMore("newer")}
            disabled={loadingNewer}
          >
            {loadingNewer ? "読み込み中…" : "新しいメモを読み込む"}
          </button>
        </div>
      )}
      {optimistic.length === 0 ? (
        keyword !== null ? (
          <div className="fog-empty">
            <h2>「{keyword}」に一致するメモは見つかりませんでした</h2>
            <p>
              <button
                type="button"
                className="fog-secondary"
                onClick={() => void goto({ date: search.date })}
              >
                絞り込みを解除
              </button>
            </p>
          </div>
        ) : (
          <div className="fog-empty">
            <span className="fog-empty-mark" aria-hidden="true">
              ＋
            </span>
            <h2>最初のメモを残そう</h2>
            <p>
              思いつきも、今日の出来事も。下の入力欄から気軽に書き留めてください。
            </p>
          </div>
        )
      ) : (
        groups.map(([day, entries]) => (
          <section className="fog-day" key={day}>
            <h2>{day}</h2>
            {entries.map((memo) => (
              <MemoEntry
                key={memo.id}
                memo={memo}
                highlighted={
                  target?.state === "found" && target.memoId === memo.id
                }
                onDelete={setDeleteTarget}
                onSaved={onSaved}
              />
            ))}
          </section>
        ))
      )}
      {loadError && (
        <p className="fog-error" role="alert">
          {loadError}
        </p>
      )}
      <div ref={olderSentinel} className="fog-load-more">
        {olderCursor && (
          <button
            type="button"
            className="fog-secondary"
            onClick={() => loadMore("older")}
            disabled={loadingOlder}
          >
            {loadingOlder ? "読み込み中…" : "過去のメモを読み込む"}
          </button>
        )}
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="メモを削除しますか？"
        description="メモはゴミ箱に移動し、保持期限を過ぎると完全に削除されます。"
        confirmLabel="削除"
        danger
        pending={deleting}
        onConfirm={() => {
          if (deleteTarget) runDelete(deleteTarget);
        }}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
      />
      <div className="fog-composer-wrap">
        <form
          className="fog-composer"
          action={action}
          onSubmit={guardSubmit}
          aria-label="メモを投稿"
        >
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
