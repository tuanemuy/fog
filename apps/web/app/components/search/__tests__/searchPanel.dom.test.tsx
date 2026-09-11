import type { SearchOutputView } from "@repo/core/application/search/view";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import {
  SearchPanel,
  type SearchPanelProps,
} from "@/components/search/SearchPanel";
import { SearchSkeleton } from "@/components/search/SearchSkeleton";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  searchMoreFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/search/actions", () => ({
  searchMoreFn: mocks.searchMoreFn,
}));

afterEach(() => {
  vi.clearAllMocks();
});

const AT = new Date("2026-09-08T01:00:00.000Z");

const TOPICS = [
  { id: "t1", name: "読書メモ", archived: false },
  { id: "t2", name: "確定申告", archived: true },
];

function page(
  items: SearchOutputView["items"],
  overrides: Partial<SearchOutputView> = {},
): SearchOutputView {
  return { items, count: items.length, nextCursor: null, ...overrides };
}

const MEMO = {
  type: "memo" as const,
  id: "m1",
  snippet: "fogsearch 横断検索用の単独メモ",
  timestamp: AT,
  sourceOfDocumentIds: [],
};

const DOC = {
  type: "document" as const,
  id: "d1",
  snippet: "資料 fogsearch 検索Aの資料本文",
  timestamp: AT,
  topicId: "t1",
  topicName: "読書メモ",
  sourceMemoIds: ["m1"],
};

async function draw(props: Partial<SearchPanelProps> = {}) {
  return renderWithRouter(
    <SearchPanel
      topics={TOPICS}
      search={{ q: "fogsearch" }}
      initial={{ kind: "results", page: page([MEMO, DOC]) }}
      {...props}
    />,
    { path: "/search" },
  );
}

const keywordBox = () =>
  screen.getByRole("searchbox", { name: "メモとドキュメントを検索" });

const formOf = (input: HTMLElement) => {
  const form = input.closest("form");
  if (form === null) throw new Error("the keyword box is not in a form");
  return form;
};

const chipsOf = () =>
  within(screen.getByRole("list", { name: "トピックで絞り込む" })).getAllByRole(
    "link",
  );

const resultRows = () =>
  within(screen.getByRole("region", { name: "検索結果" })).getAllByRole("link");

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("SearchPanel", () => {
  it("waits for a keyword and never navigates on a blank one", async () => {
    const { router } = await draw({ search: {}, initial: { kind: "idle" } });
    const navigate = vi.spyOn(router, "navigate");
    expect(screen.getByRole("status").textContent).toBe(
      "キーワードでメモとドキュメントを探せます",
    );
    const input = keywordBox();
    expect(input.getAttribute("placeholder")).toBe("メモとドキュメントを検索…");
    const form = formOf(input);
    fireEvent.submit(form);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(form);
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  fog " } });
    fireEvent.submit(form);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/search", search: { q: "fog" } }),
    );
  });

  it("keeps the scope when a new keyword is submitted", async () => {
    const { router } = await draw({ search: { q: "old", topic: "t1" } });
    const navigate = vi.spyOn(router, "navigate");
    const input = keywordBox();
    expect((input as HTMLInputElement).value).toBe("old");
    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.submit(formOf(input));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { q: "new", topic: "t1" } }),
    );
  });

  it("draws the chips with the archived badge and marks the current scope", async () => {
    await renderWithRouter(
      <SearchPanel
        topics={TOPICS}
        search={{ q: "fogsearch", topic: "t2" }}
        initial={{ kind: "results", page: page([MEMO, DOC]) }}
      />,
      { path: "/search?q=fogsearch&topic=t2" },
    );
    const chips = chipsOf();
    expect(chips.map((c) => c.textContent)).toEqual([
      "すべて",
      "読書メモ",
      "確定申告完了",
    ]);
    expect(chips.map((c) => c.getAttribute("aria-current"))).toEqual([
      null,
      null,
      "page",
    ]);
    expect(chips[0]?.getAttribute("href")).toBe("/search?q=fogsearch");
    expect(chips[1]?.getAttribute("href")).toBe("/search?q=fogsearch&topic=t1");
    const current = chips[2] as HTMLElement;
    expect(current.classList.contains("bg-primary-lighter")).toBe(true);
    expect(chips[1]?.classList.contains("bg-primary-lighter")).toBe(false);
    expect(chips[1]?.classList.contains("bg-neutral-50")).toBe(true);
    const badge = within(current).getByText("完了");
    expect(badge).not.toBe(current);
    expect(badge.classList.contains("text-primary-darker")).toBe(true);
  });

  it("marks 「すべて」 alone when no topic is chosen, and an archived chip's badge as idle", async () => {
    await renderWithRouter(
      <SearchPanel
        topics={TOPICS}
        search={{ q: "fogsearch" }}
        initial={{ kind: "results", page: page([MEMO, DOC]) }}
      />,
      { path: "/search?q=fogsearch" },
    );
    const chips = chipsOf();
    expect(chips.map((c) => c.getAttribute("aria-current"))).toEqual([
      "page",
      null,
      null,
    ]);
    expect(chips[0]?.classList.contains("bg-primary-lighter")).toBe(true);
    const badge = within(chips[2] as HTMLElement).getByText("完了");
    expect(badge.classList.contains("text-neutral-600")).toBe(true);
    expect(badge.classList.contains("text-primary-darker")).toBe(false);
  });

  it("lists the results as jump rows with kind, highlighted snippet, time, topic and destination", async () => {
    const { expectInternalHrefsToResolve } = await draw();
    expect(screen.getByText("2件")).toBeTruthy();
    const list = within(
      screen.getByRole("region", { name: "検索結果" }),
    ).getByRole("list");
    expect(list.tagName).toBe("OL");
    const rows = resultRows();
    expect(rows).toHaveLength(2);
    const memo = rows[0] as HTMLElement;
    expect(memo.getAttribute("href")).toBe("/?memo=m1");
    expect(within(memo).getByText("メモ")).toBeTruthy();
    expect(within(memo).getByText("fogsearch").tagName).toBe("MARK");
    expect(memo.querySelector("time")?.getAttribute("dateTime")).toBe(
      AT.toISOString(),
    );
    expect(memo.querySelector("svg")?.getAttribute("data-icon")).toBe("jump");
    const doc = rows[1] as HTMLElement;
    expect(doc.getAttribute("href")).toBe("/documents/d1");
    expect(within(doc).getByText("ドキュメント")).toBeTruthy();
    expect(within(doc).getByText("読書メモ")).toBeTruthy();
    expect(within(memo).queryByText("読書メモ")).toBeNull();
    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
    expect(expectInternalHrefsToResolve()).toContain("/documents/d1");
  });

  it("marks a full-width original found by a half-width keyword, on the original text", async () => {
    await draw({
      initial: {
        kind: "results",
        page: page([
          { ...MEMO, snippet: "全角の ｆｏｇｓｅａｒｃｈ を含むメモ" },
        ]),
      },
    });
    const memo = resultRows()[0] as HTMLElement;
    const mark = memo.querySelector("mark");
    expect(mark?.textContent).toBe("ｆｏｇｓｅａｒｃｈ");
    expect(mark?.parentElement?.textContent).toBe(
      "全角の ｆｏｇｓｅａｒｃｈ を含むメモ",
    );
  });

  it("says nothing was found for zero results, and offers to widen only a scoped search", async () => {
    const { unmount } = await draw({
      search: { q: "fogsearch", topic: "t1" },
      initial: { kind: "results", page: page([]) },
    });
    const scoped = screen.getByRole("status");
    expect(scoped.textContent).toContain(
      "「fogsearch」に一致するメモ・ドキュメントは見つかりませんでした",
    );
    expect(
      within(scoped)
        .getByRole("link", { name: "絞り込みを解除" })
        .getAttribute("href"),
    ).toBe("/search?q=fogsearch");
    expect(screen.queryByRole("region", { name: "検索結果" })).toBeNull();
    unmount();

    await draw({ initial: { kind: "results", page: page([]) } });
    const plain = screen.getByRole("status");
    expect(plain.textContent).toBe(
      "「fogsearch」に一致するメモ・ドキュメントは見つかりませんでした",
    );
    expect(
      within(plain).queryByRole("link", { name: "絞り込みを解除" }),
    ).toBeNull();
  });

  it("explains a missing scope topic and offers to clear it", async () => {
    await draw({
      search: { q: "fogsearch", topic: "gone" },
      initial: { kind: "topicMissing" },
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("絞り込みのトピックが見つかりません");
    expect(
      within(status)
        .getByRole("link", { name: "絞り込みを解除して検索" })
        .getAttribute("href"),
    ).toBe("/search?q=fogsearch");
  });

  it("appends the next page on もっと読む with a spinner in its place, hides it when the set is read out, and posts the scope", async () => {
    const next = deferred<SearchOutputView>();
    mocks.searchMoreFn.mockReturnValueOnce(next.promise);
    await draw({
      search: { q: "fogsearch", topic: "t1" },
      initial: {
        kind: "results",
        page: page([MEMO, DOC], { count: 3, nextCursor: "c1" }),
      },
    });
    expect(screen.getByText("3件")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "もっと読む" }));
    const loading = await screen.findByRole("status");
    expect(loading.textContent).toBe("読み込み中");
    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
    next.resolve(
      page([{ ...MEMO, id: "m2", snippet: "second" }], { count: 3 }),
    );
    await waitFor(() => expect(resultRows()).toHaveLength(3));
    expect(mocks.searchMoreFn).toHaveBeenCalledWith({
      data: { q: "fogsearch", topic: "t1", cursor: "c1" },
    });
    expect(resultRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining(MEMO.snippet),
      expect.stringContaining(DOC.snippet),
      expect.stringContaining("second"),
    ]);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
  });

  it("offers a retry in place of もっと読む when the next page fails, and a fresh search when the snapshot expired", async () => {
    mocks.searchMoreFn
      .mockRejectedValueOnce(
        new AppServerError({
          kind: "system",
          code: "DATABASE_ERROR",
          message: "x",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(
        page([{ ...MEMO, id: "m2", snippet: "later" }], {
          count: 3,
          nextCursor: "c2",
        }),
      )
      .mockRejectedValueOnce(
        new AppServerError({
          kind: "business",
          code: "INVALID_CURSOR",
          message: "x",
        }),
      );
    const { router } = await draw({
      initial: {
        kind: "results",
        page: page([MEMO], { count: 3, nextCursor: "c1" }),
      },
    });
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(screen.getByRole("button", { name: "もっと読む" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("読み込めませんでした");
    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
    expect(
      within(alert).queryByRole("button", { name: "もう一度検索" }),
    ).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(screen.getByText("later")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    // The transition may still be pending when the row lands; wait for the label.
    fireEvent.click(await screen.findByRole("button", { name: "もっと読む" }));
    const expired = await screen.findByRole("alert");
    expect(expired.textContent).toContain("検索結果の続きを読めなくなりました");
    expect(
      within(expired).queryByRole("button", { name: "再試行" }),
    ).toBeNull();
    fireEvent.click(
      within(expired).getByRole("button", { name: "もう一度検索" }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(mocks.searchMoreFn).toHaveBeenCalledTimes(3);
  });
});

describe("SearchSkeleton", () => {
  it("draws the keyword box inert with the URL's keyword, and 検索中 where the results will be", () => {
    const { container } = render(<SearchSkeleton q="fogsearch" />);
    const input = keywordBox() as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("fogsearch");
    expect(screen.getByRole("status").textContent).toBe("検索中");
    expect(container.firstElementChild?.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    const standIn = screen.getByText("読書メモ");
    expect(standIn.getAttribute("aria-hidden")).toBe("true");
    expect(standIn.classList.contains("text-transparent")).toBe(true);
  });

  it("says 読み込み中 instead when there is no keyword, only the chips to load", () => {
    render(<SearchSkeleton q={undefined} />);
    expect((keywordBox() as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("status").textContent).toBe("読み込み中");
  });
});
