import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { dayRange } from "@/presentation/time";
import { TIMELINE_PAGE_LIMIT } from "../schema";
import { type TimelineSearch, timelineModeOf } from "../search";
import { TimelineBoard, type TimelineBoardInitial } from "../TimelineBoard";

const loadPage = serverData(
  () => import("@repo/core/application/memo/getTimeline"),
  async (
    { container },
    { getTimeline },
    userId: string,
    keyword: string | null,
  ) =>
    getTimeline({
      container,
      input: { userId, limit: TIMELINE_PAGE_LIMIT, keyword },
    }),
);

const loadDay = serverData(
  () => import("@repo/core/application/memo/jumpToDate"),
  async (
    { container },
    { jumpToDate },
    userId: string,
    ymd: string,
    keyword: string | null,
  ) => {
    const { date, dayEnd } = dayRange(ymd);
    return jumpToDate({
      container,
      input: { userId, date, dayEnd, keyword, limit: TIMELINE_PAGE_LIMIT },
    });
  },
);

const loadAround = serverData(
  () => import("@repo/core/application/memo/showMemoInTimeline"),
  async (
    { container },
    { showMemoInTimeline },
    userId: string,
    memoId: string,
  ) =>
    showMemoInTimeline({
      container,
      input: { userId, memoId, limit: TIMELINE_PAGE_LIMIT },
    }),
);

/**
 * The read behind P-04 for one URL. A `?memo=` whose target is absent or
 * in the trash falls back to the plain timeline in the same loader — one
 * server function, two Durable Object calls (decision J-E).
 */
export async function loadTimelineWindow(
  userId: string,
  search: TimelineSearch,
): Promise<TimelineBoardInitial> {
  const mode = timelineModeOf(search);
  if (mode.kind === "memo") {
    const shown = await loadAround(userId, mode.memoId);
    const target = { memoId: mode.memoId, state: shown.targetState };
    if (shown.targetState === "found") {
      return {
        items: shown.items,
        olderCursor: shown.olderCursor,
        newerCursor: shown.newerCursor,
        target,
      };
    }
    const page = await loadPage(userId, null);
    return {
      items: page.items,
      olderCursor: page.nextCursor,
      newerCursor: null,
      target,
    };
  }
  if (mode.kind === "date") {
    const window = await loadDay(userId, mode.date, mode.keyword);
    return { ...window, target: null };
  }
  const page = await loadPage(userId, mode.keyword);
  return {
    items: page.items,
    olderCursor: page.nextCursor,
    newerCursor: null,
    target: null,
  };
}

/**
 * The streamed leaf of `/`: reads the window inside the RSC render and
 * hands the list to the client island that owns it from then on. The key
 * remounts the island when the URL changes and keeps it — with its
 * scrolled-in pages — across a `router.invalidate()` for the same URL.
 */
export async function TimelineFeed({ search }: { search: TimelineSearch }) {
  const initial = await guardStreamedRender(async () => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    return loadTimelineWindow(userId, search);
  });
  return (
    <TimelineBoard
      key={JSON.stringify(search)}
      initial={initial}
      search={search}
    />
  );
}
