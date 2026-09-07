import type {
  TimelineItemView,
  TimelinePageView,
} from "@repo/core/application/memo/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import {
  groupByDay,
  mergeTimeline,
  TimelineBoard,
} from "@/components/timeline/TimelineBoard";
import { AppServerError } from "@/presentation/errorResponse";
import { formatDay } from "@/presentation/time";

const mocks = vi.hoisted(() => ({
  postMemoFn: vi.fn<(input: { data: { body: string } }) => Promise<unknown>>(),
  loadTimelinePageFn:
    vi.fn<
      (input: {
        data: { cursor: string | null; direction: string; limit: number };
      }) => Promise<TimelinePageView>
    >(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/timeline/actions", () => ({
  postMemoFn: mocks.postMemoFn,
  loadTimelinePageFn: mocks.loadTimelinePageFn,
}));

class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
});

afterEach(() => {
  vi.clearAllMocks();
});

// 23:00 JST on Jan 1 and 00:30 JST on Jan 2: 90 minutes apart in UTC, on
// different Asia/Tokyo days.
const JAN_1_LATE = new Date("2026-01-01T14:00:00Z");
const JAN_2_EARLY = new Date("2026-01-01T15:30:00Z");
const JAN_1_EARLIER = new Date("2026-01-01T13:00:00Z");

function memo(id: string, body: string, postedAt: Date): TimelineItemView {
  return {
    id,
    body,
    postedAt,
    updatedAt: postedAt,
    latestRevisionNumber: 1,
    version: 1,
    sourceDocuments: [],
  };
}

function page(
  items: readonly TimelineItemView[],
  nextCursor: string | null = null,
): TimelinePageView {
  return { items, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function composer() {
  const form = screen.getByRole("form", { name: "メモを投稿" });
  return {
    form,
    textarea: within(form).getByLabelText("メモ") as HTMLTextAreaElement,
    submit: within(form).getByRole("button") as HTMLButtonElement,
  };
}

describe("mergeTimeline", () => {
  it("dedupes by id, preferring the loader page", () => {
    const stale = memo("a", "stale", JAN_1_LATE);
    const fresh = memo("a", "fresh", JAN_1_LATE);
    const merged = mergeTimeline(
      [fresh],
      [stale, memo("b", "b", JAN_1_EARLIER)],
    );
    expect(merged.map((item) => [item.id, item.body])).toEqual([
      ["a", "fresh"],
      ["b", "b"],
    ]);
  });

  it("sorts newest first, ties broken by id descending", () => {
    const merged = mergeTimeline(
      [memo("a", "a", JAN_1_LATE), memo("old", "old", JAN_1_EARLIER)],
      [memo("b", "b", JAN_1_LATE), memo("new", "new", JAN_2_EARLY)],
    );
    expect(merged.map((item) => item.id)).toEqual(["new", "b", "a", "old"]);
  });
});

describe("groupByDay", () => {
  it("answers no groups for no memos", () => {
    expect(groupByDay([])).toEqual([]);
  });

  it("keeps same-day memos under one heading, in input order", () => {
    const groups = groupByDay([
      memo("late", "x", JAN_1_LATE),
      memo("earlier", "y", JAN_1_EARLIER),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.[0]).toBe(formatDay(JAN_1_LATE));
    expect(groups[0]?.[1].map((item) => item.id)).toEqual(["late", "earlier"]);
  });

  it("splits Asia/Tokyo days even when the UTC date is the same", () => {
    const groups = groupByDay([
      memo("jan2", "x", JAN_2_EARLY),
      memo("jan1", "y", JAN_1_LATE),
    ]);
    expect(groups.map(([day]) => day)).toEqual([
      formatDay(JAN_2_EARLY),
      formatDay(JAN_1_LATE),
    ]);
    expect(formatDay(JAN_2_EARLY)).not.toBe(formatDay(JAN_1_LATE));
  });
});

describe("TimelineBoard", () => {
  it("draws the empty state and enables posting once a body is typed", async () => {
    await renderWithRouter(<TimelineBoard initial={page([])} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "最初のメモを残そう",
    );
    const { textarea, submit } = composer();
    expect(submit.disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(submit.disabled).toBe(false);
    expect(
      screen.queryByRole("button", { name: "過去のメモを読み込む" }),
    ).toBeNull();
  });

  it("groups memos under newest-first day headings", async () => {
    await renderWithRouter(
      <TimelineBoard
        initial={page([
          memo("m2", "second day", JAN_2_EARLY),
          memo("m1", "first day", JAN_1_LATE),
        ])}
      />,
    );
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      formatDay(JAN_2_EARLY),
      formatDay(JAN_1_LATE),
    ]);
    const days = screen.getAllByRole("article");
    expect(days.map((article) => article.id)).toEqual(["memo-m2", "memo-m1"]);
    expect(screen.queryByText("最初のメモを残そう")).toBeNull();
  });

  it("keeps same-day memos under one heading", async () => {
    await renderWithRouter(
      <TimelineBoard
        initial={page([
          memo("m2", "late", JAN_1_LATE),
          memo("m1", "earlier", JAN_1_EARLIER),
        ])}
      />,
    );
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("shows the optimistic entry before the post settles, then clears the draft", async () => {
    const post = deferred<unknown>();
    mocks.postMemoFn.mockReturnValue(post.promise);
    const { router } = await renderWithRouter(
      <TimelineBoard initial={page([memo("m1", "existing", JAN_1_LATE)])} />,
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { textarea, submit } = composer();
    fireEvent.change(textarea, { target: { value: "optimistic body" } });
    fireEvent.click(submit);

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("保存中…");
    const entry = status.closest("article");
    expect(entry?.getAttribute("aria-busy")).toBe("true");
    expect(entry?.textContent).toContain("optimistic body");
    expect(screen.getAllByRole("article")[0]).toBe(entry);
    expect(mocks.postMemoFn).toHaveBeenCalledWith({
      data: { body: "optimistic body" },
    });
    expect(invalidate).not.toHaveBeenCalled();

    post.resolve({ memoId: "new" });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(composer().textarea.value).toBe(""));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the draft and shows the message when the post fails", async () => {
    mocks.postMemoFn.mockRejectedValue(
      new AppServerError({
        kind: "business",
        code: "EMPTY_BODY",
        message: "x",
      }),
    );
    const { router } = await renderWithRouter(
      <TimelineBoard initial={page([memo("m1", "existing", JAN_1_LATE)])} />,
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { textarea, submit } = composer();
    fireEvent.change(textarea, { target: { value: "will fail" } });
    fireEvent.click(submit);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("メモを入力してください");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(composer().textarea.value).toBe("will fail");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("loads the older page behind the cursor and appends it", async () => {
    mocks.loadTimelinePageFn.mockResolvedValue(
      page([memo("older", "older memo", JAN_1_EARLIER)], null),
    );
    await renderWithRouter(
      <TimelineBoard
        initial={page([memo("m1", "existing", JAN_1_LATE)], "cursor-1")}
      />,
    );
    const button = screen.getByRole("button", { name: "過去のメモを読み込む" });
    fireEvent.click(button);
    expect(mocks.loadTimelinePageFn).toHaveBeenCalledWith({
      data: { cursor: "cursor-1", direction: "older", limit: 30 },
    });
    await screen.findByText("older memo");
    expect(screen.getAllByRole("article").map((a) => a.id)).toEqual([
      "memo-m1",
      "memo-older",
    ]);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "過去のメモを読み込む" }),
      ).toBeNull(),
    );
  });
});
