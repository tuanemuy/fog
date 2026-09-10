import type { SearchOutputView } from "@repo/core/application/search/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import {
  SearchPanel,
  type SearchPanelProps,
} from "@/components/search/SearchPanel";
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

describe("SearchPanel", () => {
  it("waits for a keyword and never navigates on a blank one", async () => {
    const { router } = await draw({ search: {}, initial: { kind: "idle" } });
    const navigate = vi.spyOn(router, "navigate");
    expect(screen.getByRole("status").textContent).toContain(
      "キーワードを入力すると",
    );
    const form = screen.getByRole("form", { name: "メモとドキュメントを検索" });
    fireEvent.submit(form);
    fireEvent.change(within(form).getByRole("searchbox"), {
      target: { value: "   " },
    });
    fireEvent.submit(form);
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByRole("searchbox"), {
      target: { value: "  fog " },
    });
    fireEvent.submit(form);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/search", search: { q: "fog" } }),
    );
  });

  it("keeps the scope when a new keyword is submitted", async () => {
    const { router } = await draw({ search: { q: "old", topic: "t1" } });
    const navigate = vi.spyOn(router, "navigate");
    const form = screen.getByRole("form", { name: "メモとドキュメントを検索" });
    fireEvent.change(within(form).getByRole("searchbox"), {
      target: { value: "new" },
    });
    fireEvent.submit(form);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { q: "new", topic: "t1" } }),
    );
  });

  it("draws the chips with the archived badge and marks the current scope", async () => {
    await draw({ search: { q: "fogsearch", topic: "t2" } });
    const chips = within(
      screen.getByRole("list", { name: "トピックで絞り込む" }),
    ).getAllByRole("link");
    expect(chips.map((c) => c.textContent)).toEqual([
      "すべて",
      "読書メモ",
      "確定申告完了",
    ]);
    expect(chips.map((c) => c.getAttribute("aria-current"))).toEqual([
      null,
      null,
      "true",
    ]);
    expect(chips[0]?.getAttribute("href")).toBe("/search?q=fogsearch");
    expect(chips[1]?.getAttribute("href")).toBe("/search?q=fogsearch&topic=t1");
    expect(within(chips[2] as HTMLElement).getByText("完了").className).toBe(
      "fog-badge",
    );
  });

  it("lists the results with kind, highlighted snippet, time, topic and destination", async () => {
    await draw();
    expect(screen.getByText("2件")).toBeTruthy();
    const rows = within(
      screen.getByRole("region", { name: "検索結果" }),
    ).getAllByRole("link");
    expect(rows).toHaveLength(2);
    const memo = rows[0] as HTMLElement;
    expect(memo.getAttribute("href")).toBe("/?memo=m1");
    expect(within(memo).getByText("メモ").className).toBe("fog-result-type");
    expect(within(memo).getByText("fogsearch").tagName).toBe("MARK");
    expect(memo.querySelector("time")?.getAttribute("dateTime")).toBe(
      AT.toISOString(),
    );
    expect(memo.querySelector(".fog-result-topic")).toBeNull();
    const doc = rows[1] as HTMLElement;
    expect(doc.getAttribute("href")).toBe("/documents/d1");
    expect(within(doc).getByText("ドキュメント").className).toBe(
      "fog-result-type",
    );
    expect(within(doc).getByText("読書メモ").className).toBe(
      "fog-result-topic",
    );
    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
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
    const memo = within(
      screen.getByRole("region", { name: "検索結果" }),
    ).getAllByRole("link")[0] as HTMLElement;
    const mark = memo.querySelector("mark");
    expect(mark?.textContent).toBe("ｆｏｇｓｅａｒｃｈ");
    expect(memo.querySelector(".fog-result-snippet")?.textContent).toBe(
      "全角の ｆｏｇｓｅａｒｃｈ を含むメモ",
    );
  });

  it("says nothing was found for zero results", async () => {
    await draw({ initial: { kind: "results", page: page([]) } });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("見つかりませんでした");
    expect(status.textContent).toContain("「fogsearch」");
  });

  it("explains a missing scope topic and offers to clear it", async () => {
    await draw({
      search: { q: "fogsearch", topic: "gone" },
      initial: { kind: "topicMissing" },
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(
      "絞り込み対象のトピックが見つかりません",
    );
    expect(
      within(status)
        .getByRole("link", { name: "絞り込みを解除して検索する" })
        .getAttribute("href"),
    ).toBe("/search?q=fogsearch");
  });

  it("appends the next page on もっと読む, hides the button when the set is read out, and posts the scope", async () => {
    mocks.searchMoreFn.mockResolvedValueOnce(
      page([{ ...MEMO, id: "m2", snippet: "second" }], { count: 3 }),
    );
    await draw({
      search: { q: "fogsearch", topic: "t1" },
      initial: {
        kind: "results",
        page: page([MEMO, DOC], { count: 3, nextCursor: "c1" }),
      },
    });
    expect(screen.getByText("3件")).toBeTruthy();
    const more = screen.getByRole("button", { name: "もっと読む" });
    fireEvent.click(more);
    await waitFor(() => expect(more.getAttribute("aria-busy")).toBe("true"));
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "検索結果" })).getAllByRole(
          "link",
        ),
      ).toHaveLength(3),
    );
    expect(mocks.searchMoreFn).toHaveBeenCalledWith({
      data: { q: "fogsearch", topic: "t1", cursor: "c1" },
    });
    const snippets = [...document.querySelectorAll(".fog-result-snippet")].map(
      (p) => p.textContent,
    );
    expect(snippets).toEqual([MEMO.snippet, DOC.snippet, "second"]);
    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
  });

  it("offers a retry when the next page fails, and a fresh search when the snapshot expired", async () => {
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
    expect(alert.textContent).toContain("システムエラー");
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(screen.getByText("later")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    // The transition may still be pending when the row lands; wait for the label.
    fireEvent.click(await screen.findByRole("button", { name: "もっと読む" }));
    const expired = await screen.findByRole("alert");
    expect(expired.textContent).toContain("もう一度検索してください");
    fireEvent.click(
      within(expired).getByRole("button", { name: "もう一度検索" }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(mocks.searchMoreFn).toHaveBeenCalledTimes(3);
  });
});
