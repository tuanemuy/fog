import type {
  TimelineItemView,
  TimelinePageView,
} from "@repo/core/application/memo/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { AppShell } from "@/components/layout/AppShell";
import type { TimelineBoardInitial } from "@/components/timeline/TimelineBoard";
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
        data: {
          cursor: string | null;
          direction: string;
          limit: number;
          keyword: string | null;
        };
      }) => Promise<TimelinePageView>
    >(),
  softDeleteMemoFn:
    vi.fn<(input: { data: { memoId: string } }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/timeline/actions", () => ({
  postMemoFn: mocks.postMemoFn,
  loadTimelinePageFn: mocks.loadTimelinePageFn,
  editMemoFn: vi.fn(),
  softDeleteMemoFn: mocks.softDeleteMemoFn,
}));

type ObserverRecord = {
  root: Element | Document | null | undefined;
  targets: Element[];
};

const observers: ObserverRecord[] = [];

class IntersectionObserverStub {
  private readonly record: ObserverRecord;
  constructor(
    _callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.record = { root: options?.root, targets: [] };
    observers.push(this.record);
  }
  observe(target: Element): void {
    this.record.targets.push(target);
  }
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
  observers.length = 0;
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
  olderCursor: string | null = null,
): TimelineBoardInitial {
  return { items, olderCursor, newerCursor: null, target: null, pivotId: null };
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
    await renderWithRouter(<TimelineBoard initial={page([])} search={{}} />);
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
        search={{}}
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
        search={{}}
      />,
    );
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("shows the optimistic entry before the post settles, then clears the draft", async () => {
    const post = deferred<unknown>();
    mocks.postMemoFn.mockReturnValue(post.promise);
    const { router } = await renderWithRouter(
      <TimelineBoard
        initial={page([memo("m1", "existing", JAN_1_LATE)])}
        search={{}}
      />,
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { textarea, submit } = composer();
    fireEvent.change(textarea, { target: { value: "optimistic body" } });
    fireEvent.click(submit);

    const status = await screen.findByRole("status");
    await waitFor(() => expect(status.textContent).toBe("保存中…"));
    const entry = status.closest("article");
    expect(entry?.getAttribute("aria-busy")).toBe("true");
    expect(entry?.textContent).toContain("optimistic body");
    expect(screen.getAllByRole("article")[0]).toBe(entry);
    await waitFor(() =>
      expect(mocks.postMemoFn).toHaveBeenCalledWith({
        data: { body: "optimistic body" },
      }),
    );
    expect(invalidate).not.toHaveBeenCalled();

    post.resolve({ memo: memo("new", "optimistic body", JAN_2_EARLY) });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(composer().textarea.value).toBe(""));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
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
      <TimelineBoard
        initial={page([memo("m1", "existing", JAN_1_LATE)])}
        search={{}}
      />,
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

  // A response that never went through `errorResponseMiddleware` — the
  // platform answering a 500 as JSON — *resolves* on the client. The board
  // must not read that as a write.
  it("treats a resolved value of the wrong shape as a system error and keeps the draft", async () => {
    mocks.postMemoFn.mockResolvedValue({ status: 500, unhandled: true });
    const { router } = await renderWithRouter(
      <TimelineBoard
        initial={page([memo("m1", "existing", JAN_1_LATE)])}
        search={{}}
      />,
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { textarea, submit } = composer();
    fireEvent.change(textarea, { target: { value: "not saved" } });
    fireEvent.click(submit);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(composer().textarea.value).toBe("not saved");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();
    expect(mocks.postMemoFn).toHaveBeenCalledTimes(1);
  });

  it("posts once when the form is submitted twice in the same frame", async () => {
    const post = deferred<unknown>();
    mocks.postMemoFn.mockReturnValue(post.promise);
    const { router } = await renderWithRouter(
      <TimelineBoard
        initial={page([memo("m1", "existing", JAN_1_LATE)])}
        search={{}}
      />,
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { textarea, form } = composer();
    fireEvent.change(textarea, { target: { value: "twice" } });
    fireEvent.submit(form);
    fireEvent.submit(form);

    await screen.findByRole("status");
    post.resolve({ memo: memo("new", "twice", JAN_2_EARLY) });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(composer().textarea.value).toBe(""));
    expect(mocks.postMemoFn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats an older page of the wrong shape as a load error", async () => {
    mocks.loadTimelinePageFn.mockResolvedValue({
      status: 500,
      unhandled: true,
    } as unknown as TimelinePageView);
    await renderWithRouter(
      <TimelineBoard
        initial={page([memo("m1", "existing", JAN_1_LATE)], "cursor-1")}
        search={{}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "過去のメモを読み込む" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("loads the older page behind the cursor and appends it", async () => {
    mocks.loadTimelinePageFn.mockResolvedValue({
      items: [memo("older", "older memo", JAN_1_EARLIER)],
      nextCursor: null,
    });
    await renderWithRouter(
      <TimelineBoard
        initial={page([memo("m1", "existing", JAN_1_LATE)], "cursor-1")}
        search={{}}
      />,
    );
    const button = screen.getByRole("button", { name: "過去のメモを読み込む" });
    fireEvent.click(button);
    expect(mocks.loadTimelinePageFn).toHaveBeenCalledWith({
      data: {
        cursor: "cursor-1",
        direction: "older",
        limit: 50,
        keyword: null,
      },
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

describe("TimelineBoard infinite scroll", () => {
  const withOlderPage = () => (
    <TimelineBoard
      initial={page([memo("m1", "existing", JAN_1_LATE)], "cursor-1")}
      search={{}}
    />
  );

  const olderSentinelObserver = () => {
    const button = screen.getByRole("button", { name: "過去のメモを読み込む" });
    return observers.find((record) =>
      record.targets.some((target) => target.contains(button)),
    );
  };

  it("watches the older sentinel against the shell's sheet, which is what scrolls", async () => {
    await renderWithRouter(<AppShell>{withOlderPage()}</AppShell>);
    await waitFor(() => expect(olderSentinelObserver()).toBeDefined());
    const sheet = screen.getByRole("main");
    expect(sheet.contains(screen.getByText("existing"))).toBe(true);
    expect(olderSentinelObserver()?.root).toBe(sheet);
  });

  it("watches it against the viewport when drawn without the shell", async () => {
    await renderWithRouter(withOlderPage());
    await waitFor(() => expect(olderSentinelObserver()).toBeDefined());
    expect(olderSentinelObserver()?.root).toBeNull();
  });
});

describe("mergeTimeline re-base", () => {
  it("lets the higher version win on either side and the loader page win a tie", () => {
    const v1 = { ...memo("a", "v1", JAN_1_LATE), version: 1 };
    const v2 = { ...memo("a", "v2", JAN_1_LATE), version: 2 };
    expect(mergeTimeline([v1], [v2])[0]?.body).toBe("v2");
    expect(mergeTimeline([v2], [v1])[0]?.body).toBe("v2");
    expect(
      mergeTimeline(
        [{ ...v1, body: "initial" }],
        [{ ...v1, body: "loaded" }],
      )[0]?.body,
    ).toBe("initial");
  });
});

describe("TimelineBoard: filter", () => {
  it("shows the no-match state with a clear action that drops q", async () => {
    const { router } = await renderWithRouter(
      <TimelineBoard initial={page([])} search={{ q: "買い物" }} />,
      { path: "/?q=買い物" },
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "「買い物」に一致するメモは見つかりませんでした",
    );
    const input = screen.getByRole("textbox", {
      name: "キーワードで絞り込む",
    }) as HTMLInputElement;
    expect(input.value).toBe("買い物");
    // Two clear affordances: the × in the bar and the empty state's button.
    const clears = screen.getAllByRole("button", { name: "絞り込みを解除" });
    expect(clears).toHaveLength(2);
    fireEvent.click(clears[1] as HTMLElement);
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty("q"),
    );
  });

  it("navigates with the submitted keyword", async () => {
    const { router } = await renderWithRouter(
      <TimelineBoard initial={page([])} search={{}} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "キーワードで絞り込む" }),
    );
    const input = screen.getByRole("textbox", { name: "キーワードで絞り込む" });
    fireEvent.change(input, { target: { value: " abc " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ q: "abc" }),
    );
  });

  it("still posts under a filter and then returns to the plain timeline", async () => {
    mocks.postMemoFn.mockResolvedValue({ memo: memo("new", "x", JAN_2_EARLY) });
    const { router } = await renderWithRouter(
      <TimelineBoard initial={page([])} search={{ q: "買い物" }} />,
      { path: "/?q=買い物" },
    );
    const { textarea, submit } = composer();
    fireEvent.change(textarea, { target: { value: "posted under filter" } });
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.postMemoFn).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty("q"),
    );
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("TimelineBoard: date jump", () => {
  it("announces the day when it holds memos", async () => {
    await renderWithRouter(
      <TimelineBoard
        initial={page([memo("m1", "on the day", JAN_1_LATE)])}
        search={{ date: "2026-01-01" }}
      />,
      { path: "/?date=2026-01-01" },
    );
    expect(screen.getByRole("status").textContent).toContain(
      "2026年1月1日(木)に移動しました",
    );
  });

  it("explains the nearest position when the day is empty and returns to the head", async () => {
    const { router } = await renderWithRouter(
      <TimelineBoard
        initial={page([memo("m1", "other day", JAN_2_EARLY)])}
        search={{ date: "2026-01-01" }}
      />,
      { path: "/?date=2026-01-01" },
    );
    expect(screen.getByRole("status").textContent).toContain(
      "にメモはありません",
    );
    fireEvent.click(screen.getByRole("button", { name: "先頭に戻る" }));
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty("date"),
    );
  });

  // B-1: the viewport starts at the memo the day resolved to, not at the
  // newest row of the window.
  it("scrolls the pivot's day group into view when the pivot heads it", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderWithRouter(
      <TimelineBoard
        initial={{
          ...page([
            memo("newer", "next day", JAN_2_EARLY),
            memo("pivot", "on the day", JAN_1_LATE),
            memo("older", "earlier that day", JAN_1_EARLIER),
          ]),
          pivotId: "pivot",
        }}
        search={{ date: "2026-01-01" }}
      />,
      { path: "/?date=2026-01-01" },
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    const scrolled = scrollIntoView.mock.instances[0] as Element;
    expect(scrolled.classList.contains("fog-day")).toBe(true);
    expect(scrolled.querySelector("article")?.id).toBe("memo-pivot");
    expect(document.querySelectorAll(".fog-memo-highlight")).toHaveLength(0);
  });

  it("scrolls the pivot row itself when it is not the first of its day", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderWithRouter(
      <TimelineBoard
        initial={{
          ...page([
            memo("first", "later that day", JAN_1_LATE),
            memo("pivot", "the oldest after the day", JAN_1_EARLIER),
          ]),
          pivotId: "pivot",
        }}
        search={{ date: "2025-12-31" }}
      />,
      { path: "/?date=2025-12-31" },
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect((scrollIntoView.mock.instances[0] as Element).id).toBe("memo-pivot");
  });

  it("does not scroll when the pivot already heads the list", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderWithRouter(
      <TimelineBoard
        initial={{
          ...page([
            memo("pivot", "newest", JAN_2_EARLY),
            memo("older", "older", JAN_1_LATE),
          ]),
          pivotId: "pivot",
        }}
        search={{ date: "2030-01-01" }}
      />,
      { path: "/?date=2030-01-01" },
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not scroll on the plain list or on a filter", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderWithRouter(
      <TimelineBoard
        initial={{ ...page([memo("m1", "x", JAN_1_LATE)]), pivotId: "m1" }}
        search={{ q: "x" }}
      />,
      { path: "/?q=x" },
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("TimelineBoard: both sentinels", () => {
  it("loads the newer page from the top sentinel and prepends it", async () => {
    mocks.loadTimelinePageFn.mockResolvedValue({
      items: [memo("newer", "newer memo", JAN_2_EARLY)],
      nextCursor: null,
    });
    await renderWithRouter(
      <TimelineBoard
        initial={{
          items: [memo("m1", "pivot", JAN_1_LATE)],
          pivotId: null,
          olderCursor: null,
          newerCursor: "cursor-newer",
          target: null,
        }}
        search={{ q: "memo" }}
      />,
      { path: "/?q=memo" },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "新しいメモを読み込む" }),
    );
    expect(mocks.loadTimelinePageFn).toHaveBeenCalledWith({
      data: {
        cursor: "cursor-newer",
        direction: "newer",
        limit: 50,
        keyword: "memo",
      },
    });
    await screen.findByText("newer memo");
    expect(screen.getAllByRole("article").map((a) => a.id)).toEqual([
      "memo-newer",
      "memo-m1",
    ]);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "新しいメモを読み込む" }),
      ).toBeNull(),
    );
  });
});

describe("TimelineBoard: position-specified visit", () => {
  it("highlights the found target and scrolls it into view", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderWithRouter(
      <TimelineBoard
        initial={{
          ...page([
            memo("m2", "other", JAN_2_EARLY),
            memo("m1", "target", JAN_1_LATE),
          ]),
          target: { memoId: "m1", state: "found" },
        }}
        search={{ memo: "m1" }}
      />,
      { path: "/?memo=m1" },
    );
    const article = document.getElementById("memo-m1");
    expect(article?.classList.contains("fog-memo-highlight")).toBe(true);
    expect(
      document
        .getElementById("memo-m2")
        ?.classList.contains("fog-memo-highlight"),
    ).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    [
      "notFound",
      "指定されたメモは見つかりません。通常のタイムラインを表示しています",
    ],
    [
      "trashed",
      "指定されたメモはゴミ箱にあります。通常のタイムラインを表示しています",
    ],
  ] as const)(
    "explains a %s target and shows the plain list",
    async (state, text) => {
      await renderWithRouter(
        <TimelineBoard
          initial={{
            ...page([memo("m1", "plain", JAN_1_LATE)]),
            target: { memoId: "gone", state },
          }}
          search={{ memo: "gone" }}
        />,
        { path: "/?memo=gone" },
      );
      expect(screen.getByRole("status").textContent).toBe(text);
      expect(document.querySelector(".fog-memo-highlight")).toBeNull();
      expect(screen.getAllByRole("article")).toHaveLength(1);
    },
  );
});

async function openDeleteDialog() {
  fireEvent.click(screen.getByRole("button", { name: "メモの操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
  return screen.findByRole("dialog", { name: "メモを削除しますか？" });
}

describe("TimelineBoard: delete is owned by the board", () => {
  it("keeps the memo when the dialog is cancelled", async () => {
    await renderWithRouter(
      <TimelineBoard
        initial={page([memo("m1", "keep", JAN_1_LATE)])}
        search={{}}
      />,
    );
    const dialog = await openDeleteDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(mocks.softDeleteMemoFn).not.toHaveBeenCalled();
  });

  it("removes the memo optimistically and keeps it gone once the server confirms", async () => {
    const del = deferred<unknown>();
    mocks.softDeleteMemoFn.mockReturnValue(del.promise);
    const { router } = await renderWithRouter(
      <TimelineBoard
        initial={page([
          memo("m2", "stays", JAN_2_EARLY),
          memo("m1", "goes", JAN_1_LATE),
        ])}
        search={{}}
      />,
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const m1 = document.getElementById("memo-m1") as HTMLElement;
    fireEvent.click(within(m1).getByRole("button", { name: "メモの操作" }));
    fireEvent.click(within(m1).getByRole("menuitem", { name: "削除" }));
    const confirm = await screen.findByRole("dialog", {
      name: "メモを削除しますか？",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "削除" }));

    await waitFor(() => expect(document.getElementById("memo-m1")).toBeNull());
    expect(mocks.softDeleteMemoFn).toHaveBeenCalledWith({
      data: { memoId: "m1" },
    });
    expect(invalidate).not.toHaveBeenCalled();

    del.resolve({ deleted: true });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.getElementById("memo-m1")).toBeNull();
    expect(screen.getAllByRole("article").map((a) => a.id)).toEqual([
      "memo-m2",
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("brings the memo back and offers a retry when the delete fails", async () => {
    mocks.softDeleteMemoFn.mockRejectedValueOnce(
      new AppServerError({
        kind: "system",
        code: "DATABASE_ERROR",
        message: "x",
        retryable: true,
      }),
    );
    await renderWithRouter(
      <TimelineBoard
        initial={page([memo("m1", "flaky", JAN_1_LATE)])}
        search={{}}
      />,
    );
    const dialog = await openDeleteDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "削除" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("システムエラーが発生しました");
    await waitFor(() =>
      expect(document.getElementById("memo-m1")).not.toBeNull(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.softDeleteMemoFn).toHaveBeenCalledTimes(1);

    mocks.softDeleteMemoFn.mockResolvedValueOnce({ deleted: true });
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await waitFor(() =>
      expect(mocks.softDeleteMemoFn).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(document.getElementById("memo-m1")).toBeNull());
  });
});

describe("TimelineBoard: N-1", () => {
  it("does not re-send the body when the first of two same-frame submits fails", async () => {
    mocks.postMemoFn.mockRejectedValue(
      new AppServerError({
        kind: "system",
        code: "DATABASE_ERROR",
        message: "x",
        retryable: true,
      }),
    );
    await renderWithRouter(
      <TimelineBoard
        initial={page([memo("m1", "existing", JAN_1_LATE)])}
        search={{}}
      />,
    );
    const { textarea, form } = composer();
    fireEvent.change(textarea, { target: { value: "twice failing" } });
    fireEvent.submit(form);
    fireEvent.submit(form);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(mocks.postMemoFn).toHaveBeenCalledTimes(1);
    expect(composer().textarea.value).toBe("twice failing");
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });
});
