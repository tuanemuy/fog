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
import { ToastProvider, ToastRegion } from "@/components/ui/Toast";
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

// The board raises its successes as toasts, so it is drawn with the frame's
// half of them: the provider and one region.
async function draw(initial: TrashListView) {
  return renderWithRouter(
    <ToastProvider>
      <TrashBoard initial={initial} />
      <aside aria-label="トースト">
        <ToastRegion />
      </aside>
    </ToastProvider>,
    { path: "/trash" },
  );
}

const toasts = () =>
  within(screen.getByRole("complementary", { name: "トースト" })).getByRole(
    "status",
  );

/** The list item holding the row titled `title` (a nested one for a set's document). */
const itemOf = (title: string) => {
  const item = screen.getByText(title).closest("li");
  if (item === null) throw new Error(`no list item around ${title}`);
  return item;
};

const button = (name: string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

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
  it("shows the one-sentence empty state with a bare 空にする disabled", async () => {
    await draw(list([]));
    const sentence = screen.getByText("ゴミ箱は空です");
    expect(sentence.parentElement?.textContent).toBe("ゴミ箱は空です");
    expect(screen.queryByRole("list", { name: "ゴミ箱の項目" })).toBeNull();
    expect(button("空にする").disabled).toBe(true);
    expect(
      screen.getByText(
        "ここにある項目は保持期限を過ぎると完全に削除されます。",
      ),
    ).toBeTruthy();
  });

  it("draws every kind with its badge and days left only, the set as an indent under its topic, and icon buttons named by the row", async () => {
    await draw(list([TOPIC, CHILD_A, CHILD_B, MEMO, DOC, ORPHAN]));
    expect(screen.queryByText("ゴミ箱は空です")).toBeNull();
    expect(button("空にする（6）").disabled).toBe(false);

    const memo = itemOf("昼に食べた店");
    expect(within(memo).getByText("メモ")).toBeTruthy();
    expect(within(memo).getByText("残り13日")).toBeTruthy();
    expect(memo.querySelector("time")).toBeNull();
    expect(memo.textContent).not.toContain("に削除");

    const restore = within(memo).getByRole("button", {
      name: "昼に食べた店 を復元",
    });
    expect(restore.textContent).toBe("");
    expect(restore.querySelector("svg")?.getAttribute("data-icon")).toBe(
      "restore",
    );
    const hardDelete = within(memo).getByRole("button", {
      name: "昼に食べた店 を完全に削除",
    });
    expect(hardDelete.textContent).toBe("");
    expect(hardDelete.querySelector("svg")?.getAttribute("data-icon")).toBe(
      "delete",
    );

    const topic = itemOf("旧サイト運用");
    expect(within(topic).getByText("トピック")).toBeTruthy();
    expect(within(topic).getAllByText("残り13日")).toHaveLength(1);
    expect(topic.textContent).not.toContain("ドキュメント2件");
    const children = within(topic).getByRole("list", {
      name: "セットで削除されたドキュメント",
    });
    const child = itemOf("ドメイン管理の手続き");
    expect(children.contains(child)).toBe(true);
    expect(within(child).queryByText("残り13日")).toBeNull();
    expect(within(child).queryByText("ドキュメント")).toBeNull();
    expect(
      within(child).getByRole("button", {
        name: "ドメイン管理の手続き を復元",
      }),
    ).toBeTruthy();

    const orphan = itemOf("親が別ページ");
    expect(children.contains(orphan)).toBe(false);
    expect(within(orphan).getByText("ドキュメント")).toBeTruthy();
    expect(within(orphan).getByText("残り13日")).toBeTruthy();
    expect(orphan.textContent).not.toContain("セットで削除");

    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
  });

  it("marks only the row being acted on busy, saying what is in flight in place of its days left", async () => {
    let release: (value: unknown) => void = () => {};
    mocks.restoreMemoFn.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await draw(list([MEMO, DOC]));
    fireEvent.click(button("昼に食べた店 を復元"));
    const memo = itemOf("昼に食べた店");
    await waitFor(() => expect(within(memo).getByText("復元中…")).toBeTruthy());
    expect(within(memo).queryByText("残り13日")).toBeNull();
    expect(memo.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(button("昼に食べた店 を復元").disabled).toBe(true);
    expect(button("昼に食べた店 を完全に削除").disabled).toBe(true);

    const doc = itemOf("2024年Q1レビュー");
    expect(within(doc).getByText("残り13日")).toBeTruthy();
    expect(within(doc).queryByText("復元中…")).toBeNull();
    expect(doc.querySelector("[aria-busy]")).toBeNull();
    expect(button("2024年Q1レビュー を復元").disabled).toBe(false);

    release({ memoId: "m1" });
    await waitFor(() => expect(screen.queryByText("昼に食べた店")).toBeNull());
  });

  it("disables a set's documents while their topic is acted on, naming the action on the topic only", async () => {
    let release: (value: unknown) => void = () => {};
    mocks.restoreTopicFn.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await draw(list([TOPIC, CHILD_A, MEMO]));
    expect(button("ドメイン管理の手続き を復元").disabled).toBe(false);
    fireEvent.click(button("旧サイト運用 を復元"));
    const topic = itemOf("旧サイト運用");
    await waitFor(() =>
      expect(within(topic).getAllByText("復元中…")).toHaveLength(1),
    );
    expect(button("ドメイン管理の手続き を復元").disabled).toBe(true);
    expect(button("ドメイン管理の手続き を完全に削除").disabled).toBe(true);
    expect(
      within(itemOf("ドメイン管理の手続き")).queryByText("復元中…"),
    ).toBeNull();
    expect(button("昼に食べた店 を復元").disabled).toBe(false);

    release({ topicId: "t1", restoredDocumentIds: ["d2", "d3"] });
    await waitFor(() => expect(screen.queryByText("旧サイト運用")).toBeNull());
    expect(screen.queryByText("ドメイン管理の手続き")).toBeNull();
    await waitFor(() =>
      expect(toasts().textContent).toBe("トピックを復元しました"),
    );
  });

  it("restores a memo optimistically with a toast and nothing to press, and puts the row back with the error under it and a retry", async () => {
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
    fireEvent.click(button("昼に食べた店 を復元"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("復元できませんでした");
    const memo = itemOf("昼に食べた店");
    expect(memo.contains(alert)).toBe(true);
    // The row's line: its text column and its buttons side by side.
    const line = within(memo)
      .getByText("昼に食べた店")
      .closest("div")?.parentElement;
    expect(
      line?.contains(within(memo).getByRole("button", { name: "リトライ" })),
    ).toBe(false);
    expect(line?.contains(button("昼に食べた店 を復元"))).toBe(true);
    expect(within(itemOf("2024年Q1レビュー")).queryByRole("alert")).toBeNull();
    expect(toasts().textContent).toBe("");

    fireEvent.click(within(alert).getByRole("button", { name: "リトライ" }));
    await waitFor(() => expect(screen.queryByText("昼に食べた店")).toBeNull());
    await waitFor(() =>
      expect(toasts().textContent).toBe("メモを復元しました"),
    );
    expect(within(toasts()).queryAllByRole("link")).toEqual([]);
    expect(within(toasts()).queryAllByRole("button")).toEqual([]);
    expect(
      screen.queryByRole("link", { name: "タイムラインで見る" }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button("空にする（1）")).toBeTruthy();
    expect(invalidate).toHaveBeenCalled();
  });

  it("asks before a set restore — counting the set when its topic is loaded — and restores the whole set on confirmation", async () => {
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
    fireEvent.click(button("ドメイン管理の手続き を復元"));
    const confirm = await screen.findByRole("dialog", {
      name: "トピックごと復元しますか？",
    });
    expect(
      within(confirm).getByText(
        "トピック「旧サイト運用」もゴミ箱にあります。トピックとそのドキュメント（2件）も一緒に復元されます。",
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(confirm).getByRole("button", { name: "トピックごと復元" }),
    );
    await waitFor(() => expect(screen.queryByText("旧サイト運用")).toBeNull());
    expect(screen.queryByText("サーバー移行")).toBeNull();
    expect(screen.getByText("昼に食べた店")).toBeTruthy();
    expect(mocks.restoreDocumentFn).toHaveBeenLastCalledWith({
      data: { documentId: "d2", confirmSetRestore: true },
    });
    await waitFor(() =>
      expect(toasts().textContent).toBe("トピックごと復元しました"),
    );
  });

  it("asks before a set restore without a count when the topic is not on the loaded page", async () => {
    mocks.restoreDocumentFn.mockResolvedValueOnce({
      result: "setRestoreConfirmationRequired",
      documentId: "d4",
      topicId: "t2",
      topicName: "別ページのトピック",
    });
    await draw(list([ORPHAN]));
    fireEvent.click(button("親が別ページ を復元"));
    const confirm = await screen.findByRole("dialog", {
      name: "トピックごと復元しますか？",
    });
    expect(
      within(confirm).getByText(
        "トピック「別ページのトピック」もゴミ箱にあります。トピックとそのドキュメントも一緒に復元されます。",
      ),
    ).toBeTruthy();
    expect(confirm.textContent).not.toContain("件");
  });

  it("cancelling the set restore leaves everything in place", async () => {
    mocks.restoreDocumentFn.mockResolvedValueOnce({
      result: "setRestoreConfirmationRequired",
      documentId: "d2",
      topicId: "t1",
      topicName: "旧サイト運用",
    });
    await draw(list([TOPIC, CHILD_A]));
    fireEvent.click(button("ドメイン管理の手続き を復元"));
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
    fireEvent.click(button("2024年Q1レビュー を復元"));
    const picker = await screen.findByRole("dialog", {
      name: "復元先のトピック",
    });
    expect(
      within(picker).getByText("元のトピックは完全に削除されています。"),
    ).toBeTruthy();
    const group = within(picker).getByRole("group", {
      name: "復元先のトピック",
    });
    await waitFor(() =>
      expect(within(group).getAllByRole("radio")).toHaveLength(3),
    );
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
      "読書メモ",
      "確定申告（完了）",
      "新しいトピックを作成",
    ]);
    expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
    expect(within(picker).queryByLabelText("トピック名")).toBeNull();

    fireEvent.click(within(group).getByLabelText("確定申告（完了）"));
    fireEvent.click(within(picker).getByRole("button", { name: "復元" }));
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

    fireEvent.click(within(group).getByLabelText("新しいトピックを作成"));
    fireEvent.change(within(picker).getByLabelText("トピック名"), {
      target: { value: " 新しい置き場 " },
    });
    fireEvent.click(within(picker).getByRole("button", { name: "復元" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.restoreDocumentFn).toHaveBeenLastCalledWith({
      data: {
        documentId: "d1",
        destination: { kind: "new", name: "新しい置き場", description: null },
      },
    });
    expect(screen.queryByText("2024年Q1レビュー")).toBeNull();
    await waitFor(() =>
      expect(toasts().textContent).toBe("ドキュメントを復元しました"),
    );
  });

  it("offers only a new topic when there is none to choose; a blank name is refused on its field, and a name error offers no candidate reload", async () => {
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
    fireEvent.click(button("2024年Q1レビュー を復元"));
    const picker = await screen.findByRole("dialog");
    const form = within(picker).getByRole("form", { name: "復元先のトピック" });
    await waitFor(() =>
      expect(
        (
          within(picker).getByLabelText(
            "新しいトピックを作成",
          ) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
    expect(within(picker).getAllByRole("radio")).toHaveLength(1);
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
    expect(name.hasAttribute("aria-invalid")).toBe(false);
    fireEvent.submit(form);
    const rejected = await within(picker).findByRole("alert");
    expect(rejected.textContent).toBe(
      "トピック名は100文字以内で入力してください",
    );
    expect(
      within(picker).queryByRole("button", { name: "候補を読み直す" }),
    ).toBeNull();
  });

  it("confirms a hard delete — naming the set for a topic, not for a lone item — then removes the rows with a toast", async () => {
    mocks.hardDeleteTrashItemFn.mockResolvedValue({ deleted: true });
    await draw(list([TOPIC, CHILD_A, CHILD_B, MEMO]));
    fireEvent.click(button("昼に食べた店 を完全に削除"));
    const lone = await screen.findByRole("dialog", {
      name: "完全に削除しますか？",
    });
    expect(
      within(lone).getByText("履歴ごと消え、元に戻せません。").textContent,
    ).toBe("履歴ごと消え、元に戻せません。");
    fireEvent.click(within(lone).getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(button("旧サイト運用 を完全に削除"));
    const confirm = await screen.findByRole("dialog", {
      name: "完全に削除しますか？",
    });
    expect(
      within(confirm).getByText(
        "履歴ごと消え、元に戻せません。このトピックのドキュメント（2件）も一緒に削除されます。",
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(confirm).getByRole("button", { name: "完全に削除" }),
    );
    await waitFor(() => expect(screen.queryByText("旧サイト運用")).toBeNull());
    expect(screen.queryByText("ドメイン管理の手続き")).toBeNull();
    expect(mocks.hardDeleteTrashItemFn).toHaveBeenCalledWith({
      data: { kind: "topic", id: "t1" },
    });
    expect(button("空にする（1）")).toBeTruthy();
    await waitFor(() =>
      expect(toasts().textContent).toBe("完全に削除しました"),
    );
  });

  it("empties on confirmation showing the count; a partial failure splits into a toast for what went and an alert with a retry for what stayed", async () => {
    mocks.emptyTrashFn
      .mockResolvedValueOnce({ deletedCount: 1, failedCount: 1 })
      .mockResolvedValueOnce({ deletedCount: 1, failedCount: 0 });
    await draw(list([MEMO, DOC]));
    fireEvent.click(button("空にする（2）"));
    const confirm = await screen.findByRole("dialog", {
      name: "ゴミ箱を空にしますか？",
    });
    expect(
      within(confirm).getByText(
        "全件（2件）が完全に削除され、元に戻せません。",
      ),
    ).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "空にする" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1件は削除できませんでした");
    await waitFor(() =>
      expect(toasts().textContent).toBe("1件を完全に削除しました"),
    );
    expect(toasts().textContent).not.toContain("削除できませんでした");

    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await waitFor(() =>
      expect(toasts().textContent).toContain("ゴミ箱を空にしました"),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(mocks.emptyTrashFn).toHaveBeenCalledTimes(2);
  });

  it("says a row that left the trash elsewhere is gone, drops it without a toast, and offers a reload", async () => {
    mocks.hardDeleteTrashItemFn.mockRejectedValueOnce(
      new AppServerError({
        kind: "notFound",
        code: "TRASH_ITEM_NOT_FOUND",
        message: "x",
      }),
    );
    const { router } = await draw(list([MEMO]));
    fireEvent.click(button("昼に食べた店 を完全に削除"));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "完全に削除",
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "「昼に食べた店」はゴミ箱に見つかりません。完全に削除されたか、別の画面で復元されています",
    );
    expect(alert.closest("li")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "昼に食べた店 を復元" }),
    ).toBeNull();
    expect(toasts().textContent).toBe("");
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(
      within(alert).getByRole("button", { name: "一覧を読み直す" }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("loads the next page on もっと読む, showing the load in its place", async () => {
    let release: (value: unknown) => void = () => {};
    mocks.listTrashFn.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await draw(list([MEMO], { totalCount: 2 }));
    fireEvent.click(button("もっと読む"));
    await waitFor(() => expect(screen.getByText("読み込み中")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
    release(list([DOC], { page: 2, totalCount: 2 }));
    await waitFor(() =>
      expect(screen.getByText("2024年Q1レビュー")).toBeTruthy(),
    );
    expect(mocks.listTrashFn).toHaveBeenCalledWith({
      data: { page: 2, limit: 100 },
    });
    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
    expect(screen.queryByText("読み込み中")).toBeNull();
  });

  it("keeps the rows loaded so far when the next page fails, and retries it", async () => {
    mocks.listTrashFn
      .mockRejectedValueOnce(
        new AppServerError({
          kind: "system",
          code: "DATABASE_ERROR",
          message: "x",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(list([DOC], { page: 2, totalCount: 2 }));
    await draw(list([MEMO], { totalCount: 2 }));
    fireEvent.click(button("もっと読む"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("続きを読み込めませんでした");
    expect(screen.getByText("昼に食べた店")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "もっと読む" })).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await waitFor(() =>
      expect(screen.getByText("2024年Q1レビュー")).toBeTruthy(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
