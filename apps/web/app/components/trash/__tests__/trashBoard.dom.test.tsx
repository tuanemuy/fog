import type {
  TrashItemView,
  TrashListView,
} from "@repo/core/application/trash/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import {
  groupRows,
  remainingLabel,
  TrashBoard,
} from "@/components/trash/TrashBoard";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  listTrashFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  loadRestoreDestinationsFn: vi.fn<(input: unknown) => Promise<unknown>>(),
  restoreMemoFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  restoreDocumentFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  restoreTopicFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  hardDeleteTrashItemFn:
    vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  emptyTrashFn: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/trash/actions", () => mocks);

afterEach(() => {
  vi.clearAllMocks();
});

const NOW = new Date();
const trashedAt = new Date(NOW.getTime() - 2 * 86_400_000);
const expiresAt = new Date(NOW.getTime() + 12 * 86_400_000 + 3_600_000);

const MEMO: TrashItemView = {
  kind: "memo",
  id: "m1",
  excerpt: "昼に食べた店",
  trashedAt,
  expiresAt,
};
const DOC: TrashItemView = {
  kind: "document",
  id: "d1",
  title: "2024年Q1レビュー",
  topicId: "t9",
  deletedWithTopic: false,
  trashedAt,
  expiresAt,
};
const TOPIC: TrashItemView = {
  kind: "topic",
  id: "t1",
  name: "旧サイト運用",
  setDocumentIds: ["d2", "d3"],
  trashedAt,
  expiresAt,
};
const CHILD_A: TrashItemView = {
  kind: "document",
  id: "d2",
  title: "ドメイン管理の手続き",
  topicId: "t1",
  deletedWithTopic: true,
  trashedAt,
  expiresAt,
};
const CHILD_B: TrashItemView = {
  kind: "document",
  id: "d3",
  title: "サーバー移行",
  topicId: "t1",
  deletedWithTopic: true,
  trashedAt,
  expiresAt,
};
const ORPHAN: TrashItemView = {
  kind: "document",
  id: "d4",
  title: "親が別ページ",
  topicId: "t2",
  deletedWithTopic: true,
  trashedAt,
  expiresAt,
};

function list(
  items: TrashItemView[],
  overrides: Partial<TrashListView> = {},
): TrashListView {
  return { items, totalCount: items.length, page: 1, limit: 100, ...overrides };
}

async function draw(initial: TrashListView) {
  return renderWithRouter(<TrashBoard initial={initial} />, { path: "/trash" });
}

const rowOf = (title: string) =>
  screen.getByText(title).closest(".fog-trash-row") as HTMLElement;

describe("remainingLabel / groupRows", () => {
  it("rounds the days up and says imminent past the deadline", () => {
    expect(remainingLabel(expiresAt, NOW)).toBe("残り13日");
    expect(remainingLabel(new Date(NOW.getTime() + 1), NOW)).toBe("残り1日");
    expect(remainingLabel(new Date(NOW.getTime() - 1), NOW)).toBe(
      "まもなく削除",
    );
  });

  it("nests a set's documents under their topic and leaves the rest flat", () => {
    const rows = groupRows([TOPIC, CHILD_A, MEMO, CHILD_B, ORPHAN, DOC]);
    expect(rows.map((r) => `${r.item.kind}:${r.item.id}`)).toEqual([
      "topic:t1",
      "memo:m1",
      "document:d4",
      "document:d1",
    ]);
    expect(rows[0]?.children.map((c) => c.id)).toEqual(["d2", "d3"]);
  });
});

describe("TrashBoard", () => {
  it("shows the empty state with 空にする disabled", async () => {
    await draw(list([]));
    expect(screen.getByRole("status").textContent).toContain("ゴミ箱は空です");
    expect(
      (
        screen.getByRole("button", {
          name: "空にする（0）",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("draws every kind with its badge, remaining days, deletion time and the set relation", async () => {
    await draw(list([TOPIC, CHILD_A, CHILD_B, MEMO, DOC, ORPHAN]));
    const memo = rowOf("昼に食べた店");
    expect(within(memo).getByText("メモ").className).toBe("fog-trash-pill");
    expect(within(memo).getByText("残り13日")).toBeTruthy();
    expect(memo.querySelector("time")?.getAttribute("dateTime")).toBe(
      trashedAt.toISOString(),
    );
    const topic = rowOf("旧サイト運用");
    expect(within(topic).getByText("ドキュメント2件・残り13日")).toBeTruthy();
    const children = screen.getByRole("list", {
      name: "セットで削除されたドキュメント",
    });
    expect(
      within(children)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("トピックとセットで削除"),
      ]),
    );
    expect(within(children).getByText("ドメイン管理の手続き")).toBeTruthy();
    expect(
      within(rowOf("親が別ページ")).getByText(
        "トピックとセットで削除・残り13日",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "空にする（6）" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
  });

  it("restores a memo optimistically, offers the timeline link, and puts the row back on a failure with a retry", async () => {
    mocks.restoreMemoFn
      .mockRejectedValueOnce(
        new AppServerError({
          kind: "system",
          code: "DATABASE_ERROR",
          message: "x",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce({ memoId: "m1" });
    const { router } = await draw(list([MEMO, DOC]));
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(
      screen.getByRole("button", { name: "昼に食べた店 を復元" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("復元できませんでした");
    expect(rowOf("昼に食べた店")).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(screen.queryByText("昼に食べた店")).toBeNull());
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("メモを復元しました");
    expect(
      within(status)
        .getByRole("link", { name: "タイムラインで見る" })
        .getAttribute("href"),
    ).toBe("/?memo=m1");
    expect(screen.getByRole("button", { name: "空にする（1）" })).toBeTruthy();
    expect(invalidate).toHaveBeenCalled();
  });

  it("asks before a set restore and restores the whole set on confirmation", async () => {
    mocks.restoreDocumentFn
      .mockResolvedValueOnce({
        result: "setRestoreConfirmationRequired",
        documentId: "d2",
        topicId: "t1",
        topicName: "旧サイト運用",
      })
      .mockResolvedValueOnce({
        result: "restored",
        documentId: "d2",
        restoredTopicId: "t1",
      });
    await draw(list([TOPIC, CHILD_A, CHILD_B, MEMO]));
    fireEvent.click(
      screen.getByRole("button", { name: "ドメイン管理の手続き を復元" }),
    );
    const confirm = await screen.findByRole("dialog");
    expect(confirm.textContent).toContain(
      "トピック「旧サイト運用」とセットで復元しますか？",
    );
    fireEvent.click(
      within(confirm).getByRole("button", { name: "セットで復元" }),
    );
    await waitFor(() => expect(screen.queryByText("旧サイト運用")).toBeNull());
    expect(screen.queryByText("サーバー移行")).toBeNull();
    expect(screen.getByText("昼に食べた店")).toBeTruthy();
    expect(mocks.restoreDocumentFn).toHaveBeenLastCalledWith({
      data: { documentId: "d2", confirmSetRestore: true },
    });
  });

  it("cancelling the set restore leaves everything in place", async () => {
    mocks.restoreDocumentFn.mockResolvedValueOnce({
      result: "setRestoreConfirmationRequired",
      documentId: "d2",
      topicId: "t1",
      topicName: "旧サイト運用",
    });
    await draw(list([TOPIC, CHILD_A]));
    fireEvent.click(
      screen.getByRole("button", { name: "ドメイン管理の手続き を復元" }),
    );
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(
      within(confirm).getByRole("button", { name: "キャンセル" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("ドメイン管理の手続き")).toBeTruthy();
    expect(mocks.restoreDocumentFn).toHaveBeenCalledTimes(1);
  });

  it("asks for a destination when the topic is gone: an existing topic, or a new one; an unavailable choice is explained", async () => {
    mocks.restoreDocumentFn
      .mockResolvedValueOnce({
        result: "destinationSelectionRequired",
        documentId: "d1",
      })
      .mockRejectedValueOnce(
        new AppServerError({
          kind: "notFound",
          code: "TOPIC_NOT_FOUND",
          message: "x",
        }),
      )
      .mockResolvedValueOnce({
        result: "restored",
        documentId: "d1",
        restoredTopicId: "tNew",
      });
    mocks.loadRestoreDestinationsFn.mockResolvedValue({
      topics: [
        { id: "tA", name: "読書メモ", status: "active" },
        { id: "tB", name: "確定申告", status: "archived" },
      ],
    });
    await draw(list([DOC, MEMO]));
    fireEvent.click(
      screen.getByRole("button", { name: "2024年Q1レビュー を復元" }),
    );
    const picker = await screen.findByRole("dialog");
    expect(picker.textContent).toContain("「2024年Q1レビュー」の復元先");
    const select = (await within(picker).findByRole(
      "combobox",
    )) as unknown as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "読書メモ",
      "確定申告（完了）",
    ]);
    fireEvent.change(select, { target: { value: "tB" } });
    fireEvent.click(
      within(picker).getByRole("button", { name: "この場所へ復元" }),
    );
    const alert = await within(picker).findByRole("alert");
    expect(alert.textContent).toContain("そのトピックは選べません");
    expect(
      within(alert).getByRole("button", { name: "候補を読み直す" }),
    ).toBeTruthy();
    expect(mocks.restoreDocumentFn).toHaveBeenLastCalledWith({
      data: {
        documentId: "d1",
        destination: { kind: "existing", topicId: "tB" },
      },
    });

    fireEvent.click(within(picker).getByLabelText("新しいトピックを作る"));
    fireEvent.change(within(picker).getByLabelText("トピック名"), {
      target: { value: " 新しい置き場 " },
    });
    fireEvent.click(
      within(picker).getByRole("button", { name: "この場所へ復元" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.restoreDocumentFn).toHaveBeenLastCalledWith({
      data: {
        documentId: "d1",
        destination: { kind: "new", name: "新しい置き場", description: null },
      },
    });
    expect(screen.queryByText("2024年Q1レビュー")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "「2024年Q1レビュー」を復元しました",
    );
  });

  it("draws the destination picker as a card; a blank new name says so, and a name error offers no candidate reload", async () => {
    mocks.restoreDocumentFn
      .mockResolvedValueOnce({
        result: "destinationSelectionRequired",
        documentId: "d1",
      })
      .mockRejectedValueOnce(
        new AppServerError({
          kind: "business",
          code: "TOPIC_NAME_TOO_LONG",
          message: "x",
        }),
      );
    mocks.loadRestoreDestinationsFn.mockResolvedValue({ topics: [] });
    await draw(list([DOC]));
    fireEvent.click(
      screen.getByRole("button", { name: "2024年Q1レビュー を復元" }),
    );
    const picker = await screen.findByRole("dialog");
    const form = within(picker).getByRole("form", { name: "復元先のトピック" });
    expect(form.classList.contains("fog-dialog-box")).toBe(true);
    await waitFor(() =>
      expect(
        (
          within(picker).getByLabelText(
            "新しいトピックを作る",
          ) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
    const name = within(picker).getByLabelText(
      "トピック名",
    ) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.submit(form);
    const blank = within(picker).getByRole("alert");
    expect(blank.textContent).toBe("トピック名を入力してください");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe(blank.id);
    expect(mocks.restoreDocumentFn).toHaveBeenCalledTimes(1);

    fireEvent.change(name, { target: { value: "長すぎる名前" } });
    expect(within(picker).queryByRole("alert")).toBeNull();
    fireEvent.submit(form);
    const rejected = await within(picker).findByRole("alert");
    expect(rejected.textContent).toBe(
      "トピック名は100文字以内で入力してください",
    );
    expect(
      within(picker).queryByRole("button", { name: "候補を読み直す" }),
    ).toBeNull();
  });

  it("offers only 新規 when there is no live topic to choose", async () => {
    mocks.restoreDocumentFn.mockResolvedValueOnce({
      result: "destinationSelectionRequired",
      documentId: "d1",
    });
    mocks.loadRestoreDestinationsFn.mockResolvedValue({ topics: [] });
    await draw(list([DOC]));
    fireEvent.click(
      screen.getByRole("button", { name: "2024年Q1レビュー を復元" }),
    );
    const picker = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        (
          within(picker).getByLabelText(
            "新しいトピックを作る",
          ) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
    expect(
      (within(picker).getByLabelText("既存のトピックへ") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(within(picker).getByLabelText("トピック名")).toBeTruthy();
  });

  it("confirms a hard delete — naming the set for a topic — then removes the rows", async () => {
    mocks.hardDeleteTrashItemFn.mockResolvedValue({ deleted: true });
    await draw(list([TOPIC, CHILD_A, CHILD_B, MEMO]));
    fireEvent.click(
      screen.getByRole("button", { name: "旧サイト運用 を完全に削除" }),
    );
    const confirm = await screen.findByRole("dialog");
    expect(confirm.textContent).toContain("完全に削除しますか？");
    expect(confirm.textContent).toContain(
      "セットで削除されたドキュメント2件が対象です",
    );
    expect(confirm.textContent).toContain("元に戻せません");
    fireEvent.click(
      within(confirm).getByRole("button", { name: "完全に削除" }),
    );
    await waitFor(() => expect(screen.queryByText("旧サイト運用")).toBeNull());
    expect(screen.queryByText("ドメイン管理の手続き")).toBeNull();
    expect(mocks.hardDeleteTrashItemFn).toHaveBeenCalledWith({
      data: { kind: "topic", id: "t1" },
    });
    expect(screen.getByRole("button", { name: "空にする（1）" })).toBeTruthy();
  });

  it("empties on confirmation showing the count, and reports the items it could not erase with a retry", async () => {
    mocks.emptyTrashFn
      .mockResolvedValueOnce({ deletedCount: 1, failedCount: 1 })
      .mockResolvedValueOnce({ deletedCount: 1, failedCount: 0 });
    await draw(list([MEMO, DOC]));
    fireEvent.click(screen.getByRole("button", { name: "空にする（2）" }));
    const confirm = await screen.findByRole("dialog");
    expect(confirm.textContent).toContain(
      "ゴミ箱の2件をすべて完全に削除しますか？",
    );
    fireEvent.click(
      within(confirm).getByRole("button", { name: "すべて削除" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1件は削除できませんでした");
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "ゴミ箱を空にしました（1件）",
      ),
    );
    expect(mocks.emptyTrashFn).toHaveBeenCalledTimes(2);
  });

  it("says a row that left the trash elsewhere is gone, drops it, and offers a reload", async () => {
    mocks.hardDeleteTrashItemFn.mockRejectedValueOnce(
      new AppServerError({
        kind: "notFound",
        code: "TRASH_ITEM_NOT_FOUND",
        message: "x",
      }),
    );
    const { router } = await draw(list([MEMO]));
    fireEvent.click(
      screen.getByRole("button", { name: "昼に食べた店 を完全に削除" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "完全に削除",
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "「昼に食べた店」はゴミ箱に見つかりません。完全に削除されたか、別の画面で復元されています",
    );
    expect(
      screen.queryByRole("button", { name: "昼に食べた店 を復元" }),
    ).toBeNull();
    expect(screen.queryByRole("status")?.textContent ?? "").not.toContain(
      "処理済み",
    );
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(
      within(alert).getByRole("button", { name: "一覧を読み直す" }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("loads the next page on もっと読む", async () => {
    mocks.listTrashFn.mockResolvedValueOnce(
      list([DOC], { page: 2, totalCount: 2 }),
    );
    await draw(list([MEMO], { totalCount: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "もっと読む" }));
    await waitFor(() =>
      expect(screen.getByText("2024年Q1レビュー")).toBeTruthy(),
    );
    expect(mocks.listTrashFn).toHaveBeenCalledWith({
      data: { page: 2, limit: 100 },
    });
    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
  });
});
