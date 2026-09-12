import type {
  TimelineItemView,
  TimelinePageView,
} from "@repo/core/application/memo/view";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { toastRegion } from "@/components/__tests__/toastFrame";
import { AppShell } from "@/components/layout/AppShell";
import type { TimelineSearch } from "@/components/timeline/search";
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
  callback: IntersectionObserverCallback;
  connected: boolean;
};

const observers: ObserverRecord[] = [];

class IntersectionObserverStub {
  private readonly record: ObserverRecord;
  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.record = {
      root: options?.root,
      targets: [],
      callback,
      connected: true,
    };
    observers.push(this.record);
  }
  observe(target: Element): void {
    this.record.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.record.connected = false;
  }
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

/** The board as production draws it: inside the shell that hosts its parts. */
function renderBoard(
  initial: TimelineBoardInitial,
  search: TimelineSearch = {},
  path?: `/?${string}`,
) {
  return renderWithRouter(
    <AppShell>
      <TimelineBoard initial={initial} search={search} />
    </AppShell>,
    path === undefined ? {} : { path },
  );
}

function composer() {
  const form = screen.getByRole("form", { name: "メモを投稿" });
  return {
    form,
    textarea: within(form).getByRole("textbox", {
      name: "メモを入力",
    }) as HTMLTextAreaElement,
    submit: within(form).getByRole("button", {
      name: "メモを追加",
    }) as HTMLButtonElement,
  };
}

/**
 * The keyword bar: the `<search>` landmark (jsdom's role table predates the
 * element, so it is found by its input) in the sheet.
 */
function filterBar(): HTMLElement | null {
  const inputs = within(screen.getByRole("main")).queryAllByRole("textbox", {
    name: "キーワードで絞り込む",
  });
  return inputs[0]?.closest("search") ?? null;
}

const liveTargets = () =>
  observers.filter((record) => record.connected).flatMap((r) => r.targets);

/** The sentinel at the older (bottom) or newer (top) end of the list. */
function sentinel(direction: "older" | "newer"): Element | undefined {
  const articles = screen.queryAllByRole("article");
  const want =
    direction === "older"
      ? Node.DOCUMENT_POSITION_PRECEDING
      : Node.DOCUMENT_POSITION_FOLLOWING;
  return liveTargets().find((target) =>
    articles.every((article) => target.compareDocumentPosition(article) & want),
  );
}

function intersect(target: Element) {
  const record = [...observers]
    .reverse()
    .find((r) => r.connected && r.targets.includes(target));
  if (record === undefined) throw new Error("the target is not watched");
  act(() => {
    record.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      record as unknown as IntersectionObserver,
    );
  });
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
  it("draws the empty state as one sentence and enables posting once a body is typed", async () => {
    await renderBoard(page([]));
    expect(screen.getByText("最初のメモを書いてみましょう")).toBeTruthy();
    expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
    const { textarea, submit } = composer();
    expect(submit.disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(submit.disabled).toBe(false);
    expect(liveTargets()).toEqual([]);
  });

  it("groups memos under newest-first day headings", async () => {
    await renderBoard(
      page([
        memo("m2", "second day", JAN_2_EARLY),
        memo("m1", "first day", JAN_1_LATE),
      ]),
    );
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      formatDay(JAN_2_EARLY),
      formatDay(JAN_1_LATE),
    ]);
    const days = screen.getAllByRole("article");
    expect(days.map((article) => article.id)).toEqual(["memo-m2", "memo-m1"]);
    expect(screen.queryByText("最初のメモを書いてみましょう")).toBeNull();
  });

  it("keeps same-day memos under one heading", async () => {
    await renderBoard(
      page([
        memo("m2", "late", JAN_1_LATE),
        memo("m1", "earlier", JAN_1_EARLIER),
      ]),
    );
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("docks the composer at the foot of the shell, outside the sheet", async () => {
    await renderBoard(page([memo("m1", "existing", JAN_1_LATE)]));
    const { form } = composer();
    expect(screen.getByRole("main").contains(form)).toBe(false);
    expect(
      toastRegion().compareDocumentPosition(form) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the optimistic entry before the post settles, then clears the draft and toasts", async () => {
    const post = deferred<unknown>();
    mocks.postMemoFn.mockReturnValue(post.promise);
    const { router } = await renderBoard(
      page([memo("m1", "existing", JAN_1_LATE)]),
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { textarea, submit } = composer();
    fireEvent.change(textarea, { target: { value: "optimistic body" } });
    fireEvent.click(submit);

    const status = await screen.findByText("保存中…");
    expect(status.getAttribute("role")).toBe("status");
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
    expect(toastRegion().textContent).toBe("");

    post.resolve({ memo: memo("new", "optimistic body", JAN_2_EARLY) });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(composer().textarea.value).toBe(""));
    await waitFor(() => expect(screen.queryByText("保存中…")).toBeNull());
    expect(toastRegion().textContent).toBe("メモを追加しました");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the draft and shows the failure right above the composer", async () => {
    mocks.postMemoFn.mockRejectedValue(
      new AppServerError({
        kind: "business",
        code: "EMPTY_BODY",
        message: "x",
      }),
    );
    const { router } = await renderBoard(
      page([memo("m1", "existing", JAN_1_LATE)]),
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { textarea, submit } = composer();
    fireEvent.change(textarea, { target: { value: "will fail" } });
    fireEvent.click(submit);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("メモを入力してください")).toBeTruthy();
    expect(screen.getByRole("main").contains(alert)).toBe(false);
    expect(alert.nextElementSibling).toBe(composer().form);
    await waitFor(() => expect(screen.queryByText("保存中…")).toBeNull());
    expect(composer().textarea.value).toBe("will fail");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();
    expect(toastRegion().textContent).toBe("");
  });

  it("posts the kept draft again from the failure's 再試行", async () => {
    mocks.postMemoFn
      .mockRejectedValueOnce(
        new AppServerError({
          kind: "system",
          code: "DATABASE_ERROR",
          message: "x",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce({ memo: memo("new", "again", JAN_2_EARLY) });
    await renderBoard(page([memo("m1", "existing", JAN_1_LATE)]));
    const { textarea, submit } = composer();
    fireEvent.change(textarea, { target: { value: "again" } });
    fireEvent.click(submit);

    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(mocks.postMemoFn).toHaveBeenCalledTimes(2));
    expect(mocks.postMemoFn).toHaveBeenLastCalledWith({
      data: { body: "again" },
    });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect(composer().textarea.value).toBe(""));
  });

  // A response that never went through `errorResponseMiddleware` — the
  // platform answering a 500 as JSON — *resolves* on the client. The board
  // must not read that as a write.
  it("treats a resolved value of the wrong shape as a system error and keeps the draft", async () => {
    mocks.postMemoFn.mockResolvedValue({ status: 500, unhandled: true });
    const { router } = await renderBoard(
      page([memo("m1", "existing", JAN_1_LATE)]),
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { textarea, submit } = composer();
    fireEvent.change(textarea, { target: { value: "not saved" } });
    fireEvent.click(submit);

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("システムエラーが発生しました"),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("保存中…")).toBeNull());
    expect(composer().textarea.value).toBe("not saved");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();
    expect(mocks.postMemoFn).toHaveBeenCalledTimes(1);
  });

  it("posts once when the form is submitted twice in the same frame", async () => {
    const post = deferred<unknown>();
    mocks.postMemoFn.mockReturnValue(post.promise);
    const { router } = await renderBoard(
      page([memo("m1", "existing", JAN_1_LATE)]),
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { textarea, form } = composer();
    fireEvent.change(textarea, { target: { value: "twice" } });
    fireEvent.submit(form);
    fireEvent.submit(form);

    await screen.findByText("保存中…");
    post.resolve({ memo: memo("new", "twice", JAN_2_EARLY) });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(composer().textarea.value).toBe(""));
    expect(mocks.postMemoFn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("TimelineBoard infinite scroll", () => {
  const withOlderPage = () =>
    page([memo("m1", "existing", JAN_1_LATE)], "cursor-1");

  it("watches the older sentinel against the shell's sheet, which is what scrolls", async () => {
    await renderBoard(withOlderPage());
    await waitFor(() => expect(sentinel("older")).toBeDefined());
    const sheet = screen.getByRole("main");
    const record = observers.find((r) =>
      r.targets.includes(sentinel("older") as Element),
    );
    expect(sheet.contains(sentinel("older") as Element)).toBe(true);
    expect(record?.root).toBe(sheet);
  });

  it("loads the older page when its sentinel comes into view and appends it", async () => {
    const older = deferred<TimelinePageView>();
    mocks.loadTimelinePageFn.mockReturnValue(older.promise);
    await renderBoard(withOlderPage());
    await waitFor(() => expect(sentinel("older")).toBeDefined());
    expect(screen.queryByText("過去のメモを読み込み中")).toBeNull();

    intersect(sentinel("older") as Element);
    expect(mocks.loadTimelinePageFn).toHaveBeenCalledWith({
      data: {
        cursor: "cursor-1",
        direction: "older",
        limit: 50,
        keyword: null,
      },
    });
    const loading = await screen.findByText("過去のメモを読み込み中");
    expect(loading.closest('[role="status"]')).not.toBeNull();

    older.resolve({
      items: [memo("older", "older memo", JAN_1_EARLIER)],
      nextCursor: null,
    });
    await screen.findByText("older memo");
    expect(screen.getAllByRole("article").map((a) => a.id)).toEqual([
      "memo-m1",
      "memo-older",
    ]);
    await waitFor(() =>
      expect(screen.queryByText("過去のメモを読み込み中")).toBeNull(),
    );
    expect(sentinel("older")).toBeUndefined();
  });

  it("puts 読み込めませんでした and 再試行 where the sentinel was when the older page fails", async () => {
    mocks.loadTimelinePageFn
      .mockResolvedValueOnce({
        status: 500,
        unhandled: true,
      } as unknown as TimelinePageView)
      .mockResolvedValueOnce({
        items: [memo("older", "older memo", JAN_1_EARLIER)],
        nextCursor: null,
      });
    await renderBoard(withOlderPage());
    await waitFor(() => expect(sentinel("older")).toBeDefined());
    intersect(sentinel("older") as Element);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("読み込めませんでした")).toBeTruthy();
    expect(alert.textContent).not.toContain("システムエラー");
    expect(screen.getByRole("main").contains(alert)).toBe(true);
    expect(
      screen.getByRole("article").compareDocumentPosition(alert) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(liveTargets()).toEqual([]);

    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await screen.findByText("older memo");
    expect(mocks.loadTimelinePageFn).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("loads the newer page from the top sentinel and prepends it", async () => {
    const newer = deferred<TimelinePageView>();
    mocks.loadTimelinePageFn.mockReturnValue(newer.promise);
    await renderBoard(
      {
        items: [memo("m1", "pivot", JAN_1_LATE)],
        pivotId: null,
        olderCursor: null,
        newerCursor: "cursor-newer",
        target: null,
      },
      { q: "memo" },
      "/?q=memo",
    );
    await waitFor(() => expect(sentinel("newer")).toBeDefined());
    expect(sentinel("older")).toBeUndefined();
    intersect(sentinel("newer") as Element);
    expect(mocks.loadTimelinePageFn).toHaveBeenCalledWith({
      data: {
        cursor: "cursor-newer",
        direction: "newer",
        limit: 50,
        keyword: "memo",
      },
    });
    await screen.findByText("新しいメモを読み込み中");
    newer.resolve({
      items: [memo("newer", "newer memo", JAN_2_EARLY)],
      nextCursor: null,
    });
    await screen.findByText("newer memo");
    expect(screen.getAllByRole("article").map((a) => a.id)).toEqual([
      "memo-newer",
      "memo-m1",
    ]);
    await waitFor(() => expect(sentinel("newer")).toBeUndefined());
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
  it("opens the keyword bar from the header and filters by the submitted keyword", async () => {
    const { router } = await renderBoard(page([]));
    const toggle = within(screen.getByRole("banner")).getByRole("button", {
      name: "キーワードで絞り込む",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(filterBar()).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const bar = filterBar() as HTMLElement;
    expect(toggle.getAttribute("aria-controls")).toBe(bar.id);
    expect(screen.getByRole("main").contains(bar)).toBe(true);
    const input = within(bar).getByRole("textbox", {
      name: "キーワードで絞り込む",
    });
    expect(document.activeElement).toBe(input);
    expect(
      within(bar).queryByRole("button", { name: "絞り込みを解除" }),
    ).toBeNull();

    fireEvent.change(input, { target: { value: " abc " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ q: "abc" }),
    );
  });

  it("shows the no-match state with a clear action that drops q", async () => {
    const { router } = await renderBoard(
      page([]),
      { q: "買い物" },
      "/?q=買い物",
    );
    expect(
      screen.getByText("「買い物」に一致するメモは見つかりませんでした"),
    ).toBeTruthy();
    expect(screen.queryByText("最初のメモを書いてみましょう")).toBeNull();
    const bar = filterBar() as HTMLElement;
    const input = within(bar).getByRole("textbox", {
      name: "キーワードで絞り込む",
    }) as HTMLInputElement;
    expect(input.value).toBe("買い物");
    expect(document.activeElement).not.toBe(input);
    // Two clear affordances: the × in the bar and the empty state's button.
    const clears = screen.getAllByRole("button", { name: "絞り込みを解除" });
    expect(clears).toHaveLength(2);
    expect(bar.contains(clears[0] as HTMLElement)).toBe(true);
    fireEvent.click(clears[1] as HTMLElement);
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty("q"),
    );
  });

  it("still posts under a filter and then returns to the plain timeline", async () => {
    mocks.postMemoFn.mockResolvedValue({ memo: memo("new", "x", JAN_2_EARLY) });
    const { router } = await renderBoard(
      page([]),
      { q: "買い物" },
      "/?q=買い物",
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
  it("opens the date card from the header and jumps to the picked day", async () => {
    const { router } = await renderBoard(page([memo("m1", "x", JAN_1_LATE)]));
    const calendar = within(screen.getByRole("banner")).getByRole("button", {
      name: "日付を指定して移動",
    });
    expect(calendar.getAttribute("aria-haspopup")).toBe("dialog");
    expect(calendar.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(calendar);
    const card = screen.getByRole("dialog", { name: "日付を指定して移動" });
    expect(calendar.getAttribute("aria-expanded")).toBe("true");
    const input = within(card).getByLabelText("日付を指定して移動");
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "2026-01-01" } });
    fireEvent.click(within(card).getByRole("button", { name: "移動" }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        date: "2026-01-01",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the date card on Escape and hands focus back to the calendar", async () => {
    await renderBoard(page([]));
    const calendar = screen.getByRole("button", {
      name: "日付を指定して移動",
    });
    fireEvent.click(calendar);
    const card = screen.getByRole("dialog", { name: "日付を指定して移動" });
    fireEvent.keyDown(within(card).getByLabelText("日付を指定して移動"), {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(calendar);
  });

  it("notes the asked-for day on the heading it lands under when that day is empty", async () => {
    await renderBoard(
      {
        ...page([memo("m1", "other day", JAN_2_EARLY)]),
        pivotId: "m1",
      },
      { date: "2026-01-01" },
      "/?date=2026-01-01",
    );
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe(
      `${formatDay(JAN_2_EARLY)}2026年1月1日(木)のメモはありません`,
    );
  });

  it("adds no note when the day holds memos", async () => {
    await renderBoard(
      { ...page([memo("m1", "on the day", JAN_1_LATE)]), pivotId: "m1" },
      { date: "2026-01-01" },
      "/?date=2026-01-01",
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      formatDay(JAN_1_LATE),
    );
    expect(screen.queryByText(/のメモはありません/)).toBeNull();
  });

  // B-1: the viewport starts at the memo the day resolved to, not at the
  // newest row of the window.
  it("scrolls the pivot's day group into view when the pivot heads it", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderBoard(
      {
        ...page([
          memo("newer", "next day", JAN_2_EARLY),
          memo("pivot", "on the day", JAN_1_LATE),
          memo("older", "earlier that day", JAN_1_EARLIER),
        ]),
        pivotId: "pivot",
      },
      { date: "2026-01-01" },
      "/?date=2026-01-01",
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    const scrolled = scrollIntoView.mock.instances[0] as HTMLElement;
    expect(scrolled.tagName).toBe("SECTION");
    expect(
      within(scrolled).getByRole("heading", { level: 2 }).textContent,
    ).toBe(formatDay(JAN_1_LATE));
    expect(scrolled.querySelector("article")?.id).toBe("memo-pivot");
    expect(
      document.querySelectorAll('article[aria-current="true"]'),
    ).toHaveLength(0);
  });

  it("scrolls the pivot row itself when it is not the first of its day", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderBoard(
      {
        ...page([
          memo("first", "later that day", JAN_1_LATE),
          memo("pivot", "the oldest after the day", JAN_1_EARLIER),
        ]),
        pivotId: "pivot",
      },
      { date: "2025-12-31" },
      "/?date=2025-12-31",
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect((scrollIntoView.mock.instances[0] as Element).id).toBe("memo-pivot");
  });

  it("does not scroll when the pivot already heads the list", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderBoard(
      {
        ...page([
          memo("pivot", "newest", JAN_2_EARLY),
          memo("older", "older", JAN_1_LATE),
        ]),
        pivotId: "pivot",
      },
      { date: "2030-01-01" },
      "/?date=2030-01-01",
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not scroll on the plain list or on a filter", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderBoard(
      { ...page([memo("m1", "x", JAN_1_LATE)]), pivotId: "m1" },
      { q: "x" },
      "/?q=x",
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("TimelineBoard: position-specified visit", () => {
  it("highlights the found target and scrolls it into view", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderBoard(
      {
        ...page([
          memo("m2", "other", JAN_2_EARLY),
          memo("m1", "target", JAN_1_LATE),
        ]),
        target: { memoId: "m1", state: "found" },
      },
      { memo: "m1" },
      "/?memo=m1",
    );
    expect(
      document.getElementById("memo-m1")?.getAttribute("aria-current"),
    ).toBe("true");
    expect(
      document.getElementById("memo-m2")?.hasAttribute("aria-current"),
    ).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(toastRegion().textContent).toBe("");
  });

  it.each([
    ["notFound", "メモが見つかりませんでした"],
    ["trashed", "メモはゴミ箱にあります"],
  ] as const)(
    "toasts a %s target once and shows the plain list",
    async (state, text) => {
      await renderBoard(
        {
          ...page([memo("m1", "plain", JAN_1_LATE)]),
          target: { memoId: "gone", state },
        },
        { memo: "gone" },
        "/?memo=gone",
      );
      await waitFor(() => expect(toastRegion().textContent).toBe(text));
      expect(within(toastRegion()).getAllByText(text)).toHaveLength(1);
      expect(document.querySelector('article[aria-current="true"]')).toBeNull();
      expect(screen.getAllByRole("article")).toHaveLength(1);
      expect(screen.queryByRole("alert")).toBeNull();
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
    await renderBoard(page([memo("m1", "keep", JAN_1_LATE)]));
    const dialog = await openDeleteDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(mocks.softDeleteMemoFn).not.toHaveBeenCalled();
  });

  it("removes the memo optimistically, keeps it gone once the server confirms and toasts", async () => {
    const del = deferred<unknown>();
    mocks.softDeleteMemoFn.mockReturnValue(del.promise);
    const { router } = await renderBoard(
      page([memo("m2", "stays", JAN_2_EARLY), memo("m1", "goes", JAN_1_LATE)]),
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
    expect(toastRegion().textContent).toBe("");

    del.resolve({ deleted: true });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.getElementById("memo-m1")).toBeNull();
    expect(screen.getAllByRole("article").map((a) => a.id)).toEqual([
      "memo-m2",
    ]);
    expect(toastRegion().textContent).toBe("メモを削除しました");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("brings the memo back with the failure under it and a retry", async () => {
    mocks.softDeleteMemoFn.mockRejectedValueOnce(
      new AppServerError({
        kind: "system",
        code: "DATABASE_ERROR",
        message: "x",
        retryable: true,
      }),
    );
    await renderBoard(page([memo("m1", "flaky", JAN_1_LATE)]));
    const dialog = await openDeleteDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "削除" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("システムエラーが発生しました");
    await waitFor(() =>
      expect(document.getElementById("memo-m1")).not.toBeNull(),
    );
    expect(document.getElementById("memo-m1")?.nextElementSibling).toBe(alert);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.softDeleteMemoFn).toHaveBeenCalledTimes(1);
    expect(toastRegion().textContent).toBe("");

    mocks.softDeleteMemoFn.mockResolvedValueOnce({ deleted: true });
    // A row says 「リトライ」; a surface says 「再試行」.
    fireEvent.click(within(alert).getByRole("button", { name: "リトライ" }));
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
    await renderBoard(page([memo("m1", "existing", JAN_1_LATE)]));
    const { textarea, form } = composer();
    fireEvent.change(textarea, { target: { value: "twice failing" } });
    fireEvent.submit(form);
    fireEvent.submit(form);

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("システムエラーが発生しました"),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("保存中…")).toBeNull());
    expect(mocks.postMemoFn).toHaveBeenCalledTimes(1);
    expect(composer().textarea.value).toBe("twice failing");
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });
});
