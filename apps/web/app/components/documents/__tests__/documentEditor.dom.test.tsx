import type {
  DocumentView,
  SourceMemoView,
} from "@repo/core/application/knowledge/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { DocumentEditor } from "@/components/documents/DocumentEditor";
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
];

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
    save: within(form).getByRole("button", {
      name: /保存/,
    }) as HTMLButtonElement,
  };
}

async function drawCreate() {
  return renderWithRouter(
    <DocumentEditor mode="create" topicId="t1" topicName="読書メモ" />,
    { path: "/topics/$topicId/documents/new" },
  );
}

async function drawEdit() {
  return renderWithRouter(
    <DocumentEditor
      mode="edit"
      document={DOCUMENT}
      topicName="読書メモ"
      sourceMemos={SOURCES}
    />,
    { path: "/documents/$documentId/edit" },
  );
}

describe("DocumentEditor: create", () => {
  it("refuses a blank title with its message, keeps the body, and posts no change reason", async () => {
    await drawCreate();
    const { title, body, save } = editorForm("ドキュメントを作成");
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

  it("sends the picked sources, then leaves for the new document", async () => {
    mocks.loadTimelinePageFn.mockResolvedValue({
      items: [
        {
          id: "m1",
          body: "打ち合わせ\nメモ",
          postedAt: NOW,
          updatedAt: NOW,
          latestRevisionNumber: 1,
          version: 0,
          sourceDocuments: [],
        },
      ],
      nextCursor: null,
    });
    const create = deferred<unknown>();
    mocks.createDocumentFn.mockReturnValue(create.promise);
    const { router } = await drawCreate();
    const navigate = vi.spyOn(router, "navigate");

    fireEvent.click(screen.getByRole("button", { name: "出典を追加" }));
    const picker = screen.getByRole("region", { name: "出典を追加" });
    fireEvent.change(within(picker).getByLabelText("メモを検索"), {
      target: { value: " 打ち合わせ " },
    });
    fireEvent.click(within(picker).getByRole("button", { name: "検索" }));
    expect(mocks.loadTimelinePageFn).toHaveBeenCalledWith({
      data: {
        cursor: null,
        direction: "older",
        limit: 20,
        keyword: "打ち合わせ",
      },
    });
    const add = await within(picker).findByRole("button", { name: "追加" });
    expect(picker.textContent).toContain("打ち合わせ メモ");
    fireEvent.click(add);
    expect(
      within(picker)
        .getByRole("button", { name: "追加済み" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "出典から外す" })).toBeTruthy();

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
    create.resolve({ ...DOCUMENT, id: "d-new", sourceMemoIds: ["m1"] });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/documents/$documentId",
        params: { documentId: "d-new" },
      }),
    );
  });

  it("removes a picked source and searches with no keyword when the box is blank", async () => {
    mocks.loadTimelinePageFn.mockResolvedValue({
      items: [
        {
          id: "m1",
          body: "a",
          postedAt: NOW,
          updatedAt: NOW,
          latestRevisionNumber: 1,
          version: 0,
          sourceDocuments: [],
        },
      ],
      nextCursor: null,
    });
    await drawCreate();
    fireEvent.click(screen.getByRole("button", { name: "出典を追加" }));
    const picker = screen.getByRole("region", { name: "出典を追加" });
    fireEvent.click(within(picker).getByRole("button", { name: "検索" }));
    expect(mocks.loadTimelinePageFn).toHaveBeenCalledWith({
      data: { cursor: null, direction: "older", limit: 20, keyword: null },
    });
    fireEvent.click(
      await within(picker).findByRole("button", { name: "追加" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "出典から外す" }));
    expect(screen.queryByRole("button", { name: "出典から外す" })).toBeNull();
    expect(within(picker).getByRole("button", { name: "追加" })).toBeTruthy();
  });

  it("keeps the input and shows the message when the save fails", async () => {
    mocks.createDocumentFn.mockRejectedValue(
      new AppServerError({
        kind: "business",
        code: "DOCUMENT_TITLE_TOO_LONG",
        message: "x",
      }),
    );
    const { router } = await drawCreate();
    const navigate = vi.spyOn(router, "navigate");
    const { title, body, form } = editorForm("ドキュメントを作成");
    fireEvent.change(title, { target: { value: "残る" } });
    fireEvent.change(body, { target: { value: "残る本文" } });
    fireEvent.submit(form);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "タイトルは200文字以内で入力してください",
    );
    expect(editorForm("ドキュメントを作成").title.value).toBe("残る");
    expect(editorForm("ドキュメントを作成").body.value).toBe("残る本文");
    expect(navigate).not.toHaveBeenCalled();
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
    const { router } = await drawEdit();
    const navigate = vi.spyOn(router, "navigate");
    const { title, body, form } = editorForm("ドキュメントを編集");
    expect(title.value).toBe("設計メモ");
    expect(body.value).toBe("本文");
    expect(screen.getByLabelText("変更理由").getAttribute("placeholder")).toBe(
      "手動編集",
    );
    expect(screen.getByRole("region", { name: "出典" }).textContent).toContain(
      "出典メモ",
    );
    expect(screen.queryByRole("button", { name: "出典から外す" })).toBeNull();
    expect(screen.queryByRole("button", { name: "出典を追加" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "編集をやめる" }).getAttribute("href"),
    ).toBe("/documents/d1");

    fireEvent.submit(form);
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
  });

  it("warns on a conflict and re-submits on top of the current version", async () => {
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
          actor: { kind: "aiClient", clientName: "Claude" },
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
    const { router } = await drawEdit();
    const navigate = vi.spyOn(router, "navigate");
    const { body, form } = editorForm("ドキュメントを編集");
    fireEvent.change(body, { target: { value: "私の本文" } });
    fireEvent.change(screen.getByLabelText("変更理由"), {
      target: { value: " 構成を見直し " },
    });
    fireEvent.submit(form);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Claude");
    expect(alert.textContent).toContain("要約を追加");
    expect(alert.textContent).toContain("AI が書いた本文");
    expect(alert.textContent).toContain("AI のタイトル");
    expect(navigate).not.toHaveBeenCalled();
    // The alert lands while the action is still pending; the label follows.
    await waitFor(() =>
      expect(editorForm("ドキュメントを編集").save.textContent).toBe(
        "そのまま保存",
      ),
    );
    fireEvent.submit(form);
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
    expect((await screen.findByRole("alert")).textContent).toBe(
      "他の操作と競合しました。もう一度お試しください",
    );
    expect(editorForm("ドキュメントを編集").body.value).toBe("draft");
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });
});
