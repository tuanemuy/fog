import type {
  DocumentView,
  SourceMemoView,
} from "@repo/core/application/knowledge/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { DocumentEditor } from "@/components/documents/DocumentEditor";
import { AppShell } from "@/components/layout/AppShell";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  createDocumentFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  editDocumentFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  loadTimelinePageFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/documents/actions", () => ({
  createDocumentFn: mocks.createDocumentFn,
  editDocumentFn: mocks.editDocumentFn,
  trashDocumentFn: vi.fn(),
  rollbackDocumentFn: vi.fn(),
  diffDocumentRevisionsFn: vi.fn(),
}));

vi.mock("@/components/timeline/actions", () => ({
  postMemoFn: vi.fn(),
  loadTimelinePageFn: mocks.loadTimelinePageFn,
  editMemoFn: vi.fn(),
  softDeleteMemoFn: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const NOW = new Date("2026-09-08T01:00:00.000Z");

const DOCUMENT: DocumentView = {
  id: "d1",
  topicId: "t1",
  title: "設計メモ",
  body: "本文",
  latestRevision: 2,
  version: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

const SOURCES: SourceMemoView[] = [
  {
    memoId: "m1",
    snippet: "出典メモ",
    postedAt: NOW,
    deleted: false,
    linkedAt: NOW,
  },
  {
    memoId: "m2",
    snippet: "消したメモ",
    postedAt: NOW,
    deleted: true,
    linkedAt: NOW,
  },
];

const timelineItem = (id: string, body: string) => ({
  id,
  body,
  postedAt: NOW,
  updatedAt: NOW,
  latestRevisionNumber: 1,
  version: 0,
  sourceDocuments: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function editorForm(name: string) {
  const form = screen.getByRole("form", { name });
  return {
    form,
    title: within(form).getByLabelText("タイトル") as HTMLInputElement,
    body: within(form).getByLabelText("本文") as HTMLTextAreaElement,
  };
}

/** The save lives in the header, portalled in once the header has mounted. */
async function saveButton() {
  return (await within(screen.getByRole("banner")).findByRole("button", {
    name: /保存/,
  })) as HTMLButtonElement;
}

function toastRegion() {
  return screen.getByRole("status");
}

async function drawCreate() {
  const rendered = await renderWithRouter(
    <AppShell>
      <DocumentEditor mode="create" topicId="t1" topicName="読書メモ" />
    </AppShell>,
    { path: "/topics/$topicId/documents/new" },
  );
  return { ...rendered, save: await saveButton() };
}

async function drawEdit(sourceMemos: readonly SourceMemoView[] = SOURCES) {
  const rendered = await renderWithRouter(
    <AppShell>
      <DocumentEditor
        mode="edit"
        document={DOCUMENT}
        topicName="読書メモ"
        sourceMemos={sourceMemos}
      />
    </AppShell>,
    { path: "/documents/$documentId/edit" },
  );
  return { ...rendered, save: await saveButton() };
}

describe("DocumentEditor: create", () => {
  it("puts the save into the header, outside the form yet submitting it", async () => {
    const { save } = await drawCreate();
    const { form } = editorForm("ドキュメントを作成");
    expect(save.textContent).toBe("保存");
    expect(save.type).toBe("submit");
    expect(form.contains(save)).toBe(false);
    expect(screen.getByRole("main").contains(save)).toBe(false);
    expect(save.form).toBe(form);
  });

  it("refuses a blank title with its message, keeps the body, and posts no change reason", async () => {
    const { save } = await drawCreate();
    const { title, body } = editorForm("ドキュメントを作成");
    expect(save.disabled).toBe(false);
    fireEvent.change(body, { target: { value: "本文のみ" } });
    fireEvent.change(title, { target: { value: "   " } });
    fireEvent.click(save);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("タイトルを入力してください");
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(title.getAttribute("aria-describedby")).toBe(alert.id);
    expect(body.value).toBe("本文のみ");
    expect(mocks.createDocumentFn).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: "新規" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(title.hasAttribute("aria-invalid")).toBe(false);
    expect(screen.queryByLabelText("変更理由")).toBeNull();
    expect(
      screen.getByRole("link", { name: "読書メモ" }).getAttribute("href"),
    ).toBe("/topics/t1");
  });

  it("opens the picker in place of its button with the recent memos, and searches a keyword on Enter", async () => {
    mocks.loadTimelinePageFn.mockResolvedValue({
      items: [timelineItem("m1", "打ち合わせ\nメモ")],
      nextCursor: null,
    });
    await drawCreate();
    const sources = screen.getByRole("region", { name: "出典" });
    expect(within(sources).queryByRole("list")).toBeNull();
    fireEvent.click(
      within(sources).getByRole("button", { name: "出典を追加" }),
    );
    expect(
      within(sources).queryByRole("button", { name: "出典を追加" }),
    ).toBeNull();
    const query = within(sources).getByLabelText("メモを検索");
    expect(document.activeElement).toBe(query);
    expect(mocks.loadTimelinePageFn).toHaveBeenCalledWith({
      data: { cursor: null, direction: "older", limit: 20, keyword: null },
    });
    const candidates = await within(sources).findByRole("list", {
      name: "候補のメモ",
    });
    expect(candidates.textContent).toContain("打ち合わせ メモ");

    fireEvent.change(query, { target: { value: " 打ち合わせ " } });
    fireEvent.keyDown(query, { key: "Enter", isComposing: true });
    expect(mocks.loadTimelinePageFn).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(query, { key: "Enter" });
    expect(mocks.loadTimelinePageFn).toHaveBeenLastCalledWith({
      data: {
        cursor: null,
        direction: "older",
        limit: 20,
        keyword: "打ち合わせ",
      },
    });
    await waitFor(() =>
      expect(mocks.loadTimelinePageFn).toHaveBeenCalledTimes(2),
    );
    expect(mocks.createDocumentFn).not.toHaveBeenCalled();
  });

  it("adds a candidate as a source, marks it added, and removes it again", async () => {
    mocks.loadTimelinePageFn.mockResolvedValue({
      items: [timelineItem("m1", "a")],
      nextCursor: null,
    });
    await drawCreate();
    const sources = screen.getByRole("region", { name: "出典" });
    fireEvent.click(
      within(sources).getByRole("button", { name: "出典を追加" }),
    );
    const candidates = await within(sources).findByRole("list", {
      name: "候補のメモ",
    });
    fireEvent.click(
      within(candidates).getByRole("button", { name: "出典に追加" }),
    );
    const added = within(candidates).getByRole("button", {
      name: "出典に追加済み",
    }) as HTMLButtonElement;
    expect(added.disabled).toBe(true);
    const picked = within(sources).getByRole("list", { name: "出典" });
    expect(picked.textContent).toContain("a");
    fireEvent.click(
      within(picked).getByRole("button", { name: "出典から外す" }),
    );
    expect(within(sources).queryByRole("list", { name: "出典" })).toBeNull();
    expect(
      within(candidates).getByRole("button", { name: "出典に追加" }),
    ).toBeTruthy();
  });

  it("closes the picker back into its button, with the focus on it", async () => {
    mocks.loadTimelinePageFn.mockResolvedValue({
      items: [timelineItem("m1", "a")],
      nextCursor: null,
    });
    await drawCreate();
    const sources = screen.getByRole("region", { name: "出典" });
    expect(document.activeElement).not.toBe(
      within(sources).getByRole("button", { name: "出典を追加" }),
    );
    fireEvent.click(
      within(sources).getByRole("button", { name: "出典を追加" }),
    );
    await within(sources).findByRole("list", { name: "候補のメモ" });
    fireEvent.click(
      within(sources).getByRole("button", { name: "検索を閉じる" }),
    );
    expect(within(sources).queryByLabelText("メモを検索")).toBeNull();
    expect(within(sources).queryByRole("list")).toBeNull();
    expect(document.activeElement).toBe(
      within(sources).getByRole("button", { name: "出典を追加" }),
    );
  });

  it("says so when nothing matches, and offers a retry when the search fails", async () => {
    mocks.loadTimelinePageFn.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });
    mocks.loadTimelinePageFn.mockRejectedValueOnce(
      new AppServerError({
        kind: "system",
        code: "X",
        message: "x",
        retryable: true,
      }),
    );
    mocks.loadTimelinePageFn.mockResolvedValueOnce({
      items: [timelineItem("m9", "見つかった")],
      nextCursor: null,
    });
    await drawCreate();
    const sources = screen.getByRole("region", { name: "出典" });
    fireEvent.click(
      within(sources).getByRole("button", { name: "出典を追加" }),
    );
    expect(
      await within(sources).findByText("一致するメモはありません"),
    ).toBeTruthy();
    const query = within(sources).getByLabelText("メモを検索");
    fireEvent.change(query, { target: { value: "設計" } });
    fireEvent.keyDown(query, { key: "Enter" });
    const alert = await within(sources).findByRole("alert");
    expect(
      within(alert).getByText("システムエラーが発生しました"),
    ).toBeTruthy();
    expect(within(sources).queryByText("一致するメモはありません")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    expect(mocks.loadTimelinePageFn).toHaveBeenLastCalledWith({
      data: { cursor: null, direction: "older", limit: 20, keyword: "設計" },
    });
    expect(
      (await within(sources).findByRole("list", { name: "候補のメモ" }))
        .textContent,
    ).toContain("見つかった");
    expect(within(sources).queryByRole("alert")).toBeNull();
  });

  it("sends the picked sources, shows the save in flight, then leaves for the new document with a toast", async () => {
    mocks.loadTimelinePageFn.mockResolvedValue({
      items: [timelineItem("m1", "打ち合わせ")],
      nextCursor: null,
    });
    const create = deferred<unknown>();
    mocks.createDocumentFn.mockReturnValue(create.promise);
    const { router, save } = await drawCreate();
    const navigate = vi.spyOn(router, "navigate");
    fireEvent.click(screen.getByRole("button", { name: "出典を追加" }));
    fireEvent.click(await screen.findByRole("button", { name: "出典に追加" }));

    const { title, body, form } = editorForm("ドキュメントを作成");
    fireEvent.change(title, { target: { value: "新規" } });
    fireEvent.change(body, { target: { value: "本文" } });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(mocks.createDocumentFn).toHaveBeenCalledTimes(1),
    );
    expect(mocks.createDocumentFn).toHaveBeenCalledWith({
      data: {
        topicId: "t1",
        title: "新規",
        body: "本文",
        sourceMemoIds: ["m1"],
      },
    });
    await waitFor(() => expect(save.textContent).toBe("保存中…"));
    expect(save.disabled).toBe(true);
    expect(toastRegion().textContent).toBe("");
    create.resolve({ ...DOCUMENT, id: "d-new", sourceMemoIds: ["m1"] });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/documents/$documentId",
        params: { documentId: "d-new" },
      }),
    );
    expect(toastRegion().textContent).toBe("保存しました");
  });

  it("keeps the input, shows the failure at the head of the sheet and retries the save", async () => {
    mocks.createDocumentFn.mockRejectedValueOnce(
      new AppServerError({
        kind: "business",
        code: "DOCUMENT_TITLE_TOO_LONG",
        message: "x",
      }),
    );
    mocks.createDocumentFn.mockResolvedValueOnce({
      ...DOCUMENT,
      id: "d-new",
      sourceMemoIds: [],
    });
    const { router } = await drawCreate();
    const navigate = vi.spyOn(router, "navigate");
    const { title, body, form } = editorForm("ドキュメントを作成");
    fireEvent.change(title, { target: { value: "残る" } });
    fireEvent.change(body, { target: { value: "残る本文" } });
    fireEvent.submit(form);
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("タイトルは200文字以内で入力してください"),
    ).toBeTruthy();
    expect(
      alert.compareDocumentPosition(
        screen.getByRole("link", { name: "読書メモ" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(editorForm("ドキュメントを作成").title.value).toBe("残る");
    expect(editorForm("ドキュメントを作成").body.value).toBe("残る本文");
    expect(navigate).not.toHaveBeenCalled();
    expect(toastRegion().textContent).toBe("");

    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await waitFor(() =>
      expect(mocks.createDocumentFn).toHaveBeenCalledTimes(2),
    );
    expect(mocks.createDocumentFn).toHaveBeenLastCalledWith({
      data: {
        topicId: "t1",
        title: "残る",
        body: "残る本文",
        sourceMemoIds: [],
      },
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("DocumentEditor: edit", () => {
  it("opens with the document, shows sources read-only and posts the opened version", async () => {
    mocks.editDocumentFn.mockResolvedValue({
      result: "unchanged",
      latestRevision: 2,
      version: 3,
      updatedAt: NOW,
      conflict: null,
    });
    const { router, save } = await drawEdit();
    const navigate = vi.spyOn(router, "navigate");
    const { title, body } = editorForm("ドキュメントを編集");
    expect(title.value).toBe("設計メモ");
    expect(body.value).toBe("本文");
    expect(screen.getByLabelText("変更理由").getAttribute("placeholder")).toBe(
      "手動編集",
    );
    const sources = screen.getByRole("region", { name: "出典" });
    const rows = within(sources).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("出典メモ"),
      expect.stringContaining("削除済みのメモ"),
    ]);
    expect(sources.textContent).not.toContain("消したメモ");
    expect(within(sources).queryByRole("link")).toBeNull();
    expect(within(sources).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "出典を追加" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "読書メモ" }).getAttribute("href"),
    ).toBe("/topics/t1");

    fireEvent.click(save);
    await waitFor(() =>
      expect(mocks.editDocumentFn).toHaveBeenCalledWith({
        data: {
          documentId: "d1",
          title: "設計メモ",
          body: "本文",
          changeReason: null,
          expectedVersion: 3,
        },
      }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/documents/$documentId",
        params: { documentId: "d1" },
      }),
    );
    expect(toastRegion().textContent).toBe("保存しました");
  });

  it("leaves the sources out when the document has none", async () => {
    await drawEdit([]);
    expect(screen.queryByRole("region", { name: "出典" })).toBeNull();
    expect(screen.getByLabelText("変更理由")).toBeTruthy();
  });

  it("warns on a conflict at the head of the sheet and re-submits on top of the current version", async () => {
    mocks.editDocumentFn.mockResolvedValueOnce({
      result: "conflict",
      latestRevision: 3,
      version: 5,
      updatedAt: NOW,
      conflict: {
        currentTitle: "AI のタイトル",
        currentBody: "AI が書いた本文",
        currentVersion: 5,
        latestRevision: {
          revisionNumber: 3,
          actor: { kind: "aiClient", clientName: "Claude Desktop" },
          changeReason: "要約を追加",
          createdAt: NOW,
        },
      },
    });
    mocks.editDocumentFn.mockResolvedValueOnce({
      result: "saved",
      latestRevision: 4,
      version: 6,
      updatedAt: NOW,
      conflict: null,
    });
    const { router, save } = await drawEdit();
    const navigate = vi.spyOn(router, "navigate");
    const { body, form } = editorForm("ドキュメントを編集");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(body, { target: { value: "私の本文" } });
    fireEvent.change(screen.getByLabelText("変更理由"), {
      target: { value: " 構成を見直し " },
    });
    fireEvent.submit(form);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "編集中に Claude Desktop がこのドキュメントを更新しました。そのまま保存すると、自分の内容が新しいリビジョンになります。",
    );
    expect(
      alert.compareDocumentPosition(
        screen.getByRole("link", { name: "読書メモ" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    // The alert lands while the action is still pending; the label follows.
    await waitFor(() => expect(save.textContent).toBe("そのまま保存"));
    expect(toastRegion().textContent).toBe("");
    fireEvent.click(save);
    await waitFor(() => expect(mocks.editDocumentFn).toHaveBeenCalledTimes(2));
    expect(mocks.editDocumentFn).toHaveBeenLastCalledWith({
      data: {
        documentId: "d1",
        title: "設計メモ",
        body: "私の本文",
        changeReason: "構成を見直し",
        expectedVersion: 5,
      },
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  });

  it("shows the rejection and keeps the draft", async () => {
    mocks.editDocumentFn.mockRejectedValue(
      new AppServerError({
        kind: "conflict",
        code: "OPTIMISTIC_LOCK_FAILURE",
        message: "x",
        retryable: true,
      }),
    );
    const { router } = await drawEdit();
    const invalidate = vi.spyOn(router, "invalidate");
    const { body, form } = editorForm("ドキュメントを編集");
    fireEvent.change(body, { target: { value: "draft" } });
    fireEvent.submit(form);
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("他の操作と競合しました。もう一度お試しください"),
    ).toBeTruthy();
    expect(editorForm("ドキュメントを編集").body.value).toBe("draft");
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });
});
