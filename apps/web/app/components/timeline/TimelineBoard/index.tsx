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
  Fragment,
  useActionState,
  useCallback,
  useEffect,
  useId,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  HeaderActions,
  useSheetScrollContainer,
} from "@/components/layout/ShellSlots";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { RowError } from "@/components/ui/RowError";
import { useToast } from "@/components/ui/Toast";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import {
  calendarDateOf,
  formatCalendarDate,
  formatDay,
} from "@/presentation/time";
import { loadTimelinePageFn, postMemoFn, softDeleteMemoFn } from "../actions";
import { Composer } from "../Composer";
import { DateJump } from "../DateJump";
import { FilterBar } from "../FilterBar";
import { type DisplayMemo, MemoEntry } from "../MemoEntry";
import { PageEdge } from "../PageEdge";
import {
  isPostMemoResult,
  isSoftDeleteMemoResult,
  isTimelinePageResult,
  TIMELINE_PAGE_LIMIT,
} from "../schema";
import { compactSearch, type TimelineSearch, timelineModeOf } from "../search";
import {
  DAY_ENTRIES_CLASS,
  DAY_GROUP_CLASS,
  DAY_HEADING_CLASS,
  DAY_HEADING_NOTE_CLASS,
} from "../styles";

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

/** Whether the keyword bar is shown, and whether it was just opened by hand. */
type FilterBarState = "closed" | "shown" | "opened";

/** The toast a position-specified visit raises when its memo is not there. */
const MISSING_TARGET_TOAST: Readonly<
  Record<Exclude<MemoTargetState, "found">, string>
> = {
  notFound: "メモが見つかりませんでした",
  trashed: "メモはゴミ箱にあります",
};

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

/**
 * The list owner: the client island seeded by the loader that runs the
 * membership-changing mutations (posting with an optimistic entry, deleting
 * with an optimistic removal), pulls pages in from both sentinels, and
 * carries the filter / jump / position state the URL expresses.
 *
 * It is drawn inside the `AppShell`: the filter and the date jump go into
 * the header (`HeaderActions`), the composer into the shell's bottom dock,
 * and a success or a missing target is a toast on the shell.
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
  const toast = useToast();
  const post = useServerFn(postMemoFn);
  const fetchPage = useServerFn(loadTimelinePageFn);
  const softDelete = useServerFn(softDeleteMemoFn);
  const mode = timelineModeOf(search);
  const keyword = mode.kind === "memo" ? null : mode.keyword;
  const plainList = mode.kind === "list" && keyword === null;
  const filterBarId = useId();

  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState<TimelineItemView[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [cursors, setCursors] = useState<{
    older: string | null | undefined;
    newer: string | null | undefined;
  }>({ older: undefined, newer: undefined });
  // A failure belongs to the end it happened at. The two ends are both
  // reachable at once (a `?memo=` / `?date=` window has a cursor on each
  // side), and the failed end's sentinel is replaced by its retry — the only
  // way back to it — so one end's failure must not stop the other's watch.
  const [olderFailed, setOlderFailed] = useState(false);
  const [newerFailed, setNewerFailed] = useState(false);
  const [loadingOlder, startOlder] = useTransition();
  const [loadingNewer, startNewer] = useTransition();
  const busy = useRef<Record<Direction, boolean>>({
    older: false,
    newer: false,
  });
  const olderSentinel = useRef<HTMLDivElement>(null);
  const newerSentinel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const sheet = useSheetScrollContainer();
  const [filterBar, setFilterBar] = useState<FilterBarState>(
    search.q === undefined ? "closed" : "shown",
  );
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
      const setFailed = direction === "older" ? setOlderFailed : setNewerFailed;
      setFailed(false);
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
        } catch {
          // The sentence is fixed, as for a failed route load: the error's
          // own words do not reach the page.
          setFailed(true);
        } finally {
          busy.current[direction] = false;
        }
      });
    },
    [olderCursor, newerCursor, fetchPage, keyword],
  );

  useEffect(() => {
    const watched: [Element, Direction][] = [];
    if (olderCursor && !loadingOlder && !olderFailed && olderSentinel.current) {
      watched.push([olderSentinel.current, "older"]);
    }
    if (newerCursor && !loadingNewer && !newerFailed && newerSentinel.current) {
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
      // The sheet is what scrolls, so the margin that starts the next page
      // before the sentinel shows has to extend the sheet's scrollport — on
      // the viewport it would be clipped away by the sheet.
      { root: sheet.current, rootMargin: "200px" },
    );
    for (const [element] of watched) observer.observe(element);
    return () => observer.disconnect();
  }, [
    olderCursor,
    newerCursor,
    olderFailed,
    newerFailed,
    loadingOlder,
    loadingNewer,
    loadMore,
    sheet,
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

  // …and when the memo is not there, say so once and show the plain list
  // (P-04). Keyed on the state, not the object, so a refetch of the same URL
  // does not say it again.
  const missingTarget =
    mode.kind === "memo" && target !== null && target.state !== "found"
      ? target.state
      : null;
  useEffect(() => {
    if (missingTarget !== null) toast(MISSING_TARGET_TOAST[missingTarget]);
  }, [missingTarget, toast]);

  // A date jump: start the viewport at the memo the day resolved to. When
  // that memo heads its day group the group scrolls, so the day heading is
  // what the reader sees first; otherwise the memo row itself does.
  const pivotId = mode.kind === "date" ? initial.pivotId : null;
  useEffect(() => {
    if (pivotId === null) return;
    const element = document.getElementById(`memo-${pivotId}`);
    if (!element || typeof element.scrollIntoView !== "function") return;
    // Already at the head of the list: scrolling would gain nothing.
    if (list.current?.querySelector("article") === element) {
      return;
    }
    const group = element.closest("[data-day-group]");
    const headsGroup = group?.querySelector("article") === element;
    (headsGroup && group ? group : element).scrollIntoView({ block: "start" });
  }, [pivotId]);

  // A jump to a day without memos lands on the nearest one; the heading it
  // lands under says which day was asked for (状態の例「日付ジャンプ — 指定日
  // にメモが無いとき」).
  const pivot =
    pivotId === null ? undefined : optimistic.find((m) => m.id === pivotId);
  const missingDayNote =
    mode.kind === "date" &&
    pivot !== undefined &&
    !initial.items.some((memo) => calendarDateOf(memo.postedAt) === mode.date)
      ? {
          day: formatDay(pivot.postedAt),
          text: `${formatCalendarDate(mode.date)}のメモはありません`,
        }
      : null;

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
        toast("メモを追加しました");
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
        toast("メモを削除しました");
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

  const filterBarOpen = filterBar !== "closed";
  const clearFilter = () => void goto({ date: search.date });

  const groups = groupByDay(optimistic);
  return (
    <section
      ref={list}
      aria-label="メモ一覧"
      aria-busy={pending || loadingOlder || loadingNewer || deleting}
    >
      <HeaderActions>
        <IconButton
          icon="search"
          label="キーワードで絞り込む"
          size="md"
          placement="header"
          aria-expanded={filterBarOpen}
          aria-controls={filterBarOpen ? filterBarId : undefined}
          onClick={() => setFilterBar(filterBarOpen ? "closed" : "opened")}
        />
        <DateJump
          date={search.date}
          onJump={(date) => void goto({ date, q: search.q })}
        />
      </HeaderActions>
      {filterBarOpen && (
        <FilterBar
          id={filterBarId}
          keyword={search.q}
          focusOnOpen={filterBar === "opened"}
          onFilter={(q) =>
            void goto(
              q.length > 0 ? { q, date: search.date } : { date: search.date },
            )
          }
          onClear={clearFilter}
        />
      )}
      {newerCursor && (
        <PageEdge
          sentinelRef={newerSentinel}
          loading={loadingNewer}
          loadingLabel="新しいメモを読み込み中"
          failed={newerFailed}
          onRetry={() => loadMore("newer")}
        />
      )}
      {optimistic.length === 0 ? (
        keyword !== null ? (
          <EmptyState
            message={`「${keyword}」に一致するメモは見つかりませんでした`}
            action={
              <Button variant="text" onClick={clearFilter}>
                絞り込みを解除
              </Button>
            }
          />
        ) : (
          <EmptyState message="最初のメモを書いてみましょう" />
        )
      ) : (
        <div>
          {groups.map(([day, entries]) => (
            <section key={day} className={DAY_GROUP_CLASS} data-day-group="">
              <h2 className={DAY_HEADING_CLASS}>
                {day}
                {missingDayNote?.day === day && (
                  <span className={DAY_HEADING_NOTE_CLASS}>
                    {missingDayNote.text}
                  </span>
                )}
              </h2>
              <div className={DAY_ENTRIES_CLASS}>
                {entries.map((memo) => (
                  <Fragment key={memo.id}>
                    <MemoEntry
                      memo={memo}
                      highlighted={
                        target?.state === "found" && target.memoId === memo.id
                      }
                      onDelete={setDeleteTarget}
                      onSaved={onSaved}
                    />
                    {deleteFailure?.memo.id === memo.id && (
                      <RowError
                        message={deleteFailure.message}
                        retry={{
                          label: "リトライ",
                          onRetry: () => runDelete(deleteFailure.memo),
                        }}
                      />
                    )}
                  </Fragment>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {olderCursor && (
        <PageEdge
          sentinelRef={olderSentinel}
          loading={loadingOlder}
          loadingLabel="過去のメモを読み込み中"
          failed={olderFailed}
          onRetry={() => loadMore("older")}
        />
      )}
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
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        action={action}
        onSubmit={guardSubmit}
        pending={pending}
        error={state.error}
      />
    </section>
  );
}
