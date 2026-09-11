import type {
  EditMemoView,
  TimelineItemView,
} from "@repo/core/application/memo/view";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { actorLabel, MemoEntry } from "@/components/timeline/MemoEntry";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  editMemoFn:
    vi.fn<
      (input: {
        data: { memoId: string; body: string; expectedVersion: number };
      }) => Promise<unknown>
    >(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/timeline/actions", () => ({
  postMemoFn: vi.fn(),
  loadTimelinePageFn: vi.fn(),
  softDeleteMemoFn: vi.fn(),
  editMemoFn: mocks.editMemoFn,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function memo(body: string, postedAt: Date): TimelineItemView {
  return {
    id: "m1",
    body,
    postedAt,
    updatedAt: postedAt,
    latestRevisionNumber: 1,
    version: 1,
    sourceDocuments: [],
  };
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

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "メモの操作" }));
  return screen.getByRole("menu");
}

function startEditing() {
  fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "編集" }));
  const form = screen.getByRole("form", { name: "メモを編集" });
  return {
    form,
    textarea: within(form).getByLabelText("本文") as HTMLTextAreaElement,
    save: () =>
      within(form).getByRole("button", { name: /保存/ }) as HTMLButtonElement,
  };
}

describe("MemoEntry", () => {
  it("stamps the ISO instant and the Asia/Tokyo wall-clock time", async () => {
    // 14:05 UTC is 23:05 in Tokyo.
    const postedAt = new Date("2026-01-01T14:05:00Z");
    const { container } = await renderWithRouter(
      <MemoEntry memo={memo("body", postedAt)} />,
    );
    const time = container.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-01-01T14:05:00.000Z");
    expect(time?.textContent).toBe("23:05");
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      container.querySelector("article")?.getAttribute("aria-busy"),
    ).toBeNull();
  });

  it("renders a Markdown list as list items", async () => {
    await renderWithRouter(<MemoEntry memo={memo("- a\n- b", new Date(0))} />);
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["a", "b"]);
  });

  it("never inserts a script element from the body", async () => {
    const { container } = await renderWithRouter(
      <MemoEntry
        memo={memo(
          "before <script>alert(1)</script> after\n\n<script>alert(2)</script>",
          new Date(0),
        )}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("<script");
    // Without rehype-raw the tags stay visible as text — inline and
    // block-level alike — so the author's input is neither run nor lost.
    const body = screen.getByText(
      "before <script>alert(1)</script> after",
    ).parentElement;
    expect(body?.textContent?.trim()).toBe(
      "before <script>alert(1)</script> after\n<script>alert(2)</script>",
    );
  });

  it("marks a pending entry busy with a saving status and no menu", () => {
    const { container } = render(
      <MemoEntry memo={{ ...memo("x", new Date(0)), pending: true }} />,
    );
    expect(container.querySelector("article")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.getByRole("status").textContent).toBe("保存中…");
    expect(screen.queryByRole("button", { name: "メモの操作" })).toBeNull();
  });
});

describe("actorLabel", () => {
  it("names the user あなた and an AI client by its name", () => {
    expect(actorLabel({ kind: "user" })).toBe("あなた");
    expect(actorLabel({ kind: "aiClient", clientName: "Claude" })).toBe(
      "Claude",
    );
  });
});

describe("MemoEntry menu", () => {
  it("opens a menu with edit, a history link and delete", async () => {
    const onDelete = vi.fn();
    const item = memo("body", new Date(0));
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <MemoEntry memo={item} onDelete={onDelete} />,
    );
    const trigger = screen.getByRole("button", { name: "メモの操作" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();

    const menu = openMenu();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((el) => el.textContent)).toEqual(["編集", "履歴", "削除"]);
    const history = within(menu).getByRole("menuitem", { name: "履歴" });
    expect(history.getAttribute("href")).toBe("/memos/m1/history");
    expectInternalHrefsToResolve();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "削除" }));
    expect(onDelete).toHaveBeenCalledWith(item);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape", async () => {
    await renderWithRouter(<MemoEntry memo={memo("body", new Date(0))} />);
    openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("MemoEntry inline edit", () => {
  const item = memo("original body", new Date("2026-01-01T14:05:00Z"));
  const savedView = {
    id: "m1",
    body: "edited body",
    postedAt: item.postedAt,
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    latestRevisionNumber: 2,
    version: 2,
  };

  it("opens the editor with the body and refuses a blank draft", async () => {
    await renderWithRouter(<MemoEntry memo={item} />);
    const { textarea, save } = startEditing();
    expect(textarea.value).toBe("original body");
    expect(save().disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(save().disabled).toBe(true);
    expect(mocks.editMemoFn).not.toHaveBeenCalled();
  });

  it("saves with the version it started from, reports the memo and closes", async () => {
    const edit = deferred<unknown>();
    mocks.editMemoFn.mockReturnValue(edit.promise);
    const onSaved = vi.fn();
    const { router, container } = await renderWithRouter(
      <MemoEntry memo={item} onSaved={onSaved} />,
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { form, textarea } = startEditing();
    fireEvent.change(textarea, { target: { value: "edited body" } });
    fireEvent.submit(form);

    await waitFor(() =>
      expect(mocks.editMemoFn).toHaveBeenCalledWith({
        data: { memoId: "m1", body: "edited body", expectedVersion: 1 },
      }),
    );
    expect(container.querySelector("article")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.getByRole("form", { name: "メモを編集" })).toBeTruthy();

    edit.resolve({
      result: "saved",
      memo: savedView,
      conflict: null,
    } satisfies EditMemoView);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedView));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "メモを編集" })).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closes without reporting when nothing changed", async () => {
    mocks.editMemoFn.mockResolvedValue({
      result: "unchanged",
      memo: { ...savedView, body: "original body", version: 1 },
      conflict: null,
    });
    const onSaved = vi.fn();
    const { router } = await renderWithRouter(
      <MemoEntry memo={item} onSaved={onSaved} />,
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { form } = startEditing();
    fireEvent.submit(form);
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "メモを編集" })).toBeNull(),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.getByText("original body")).toBeTruthy();
  });

  it("warns on a conflict and re-submits on top of the current version", async () => {
    mocks.editMemoFn
      .mockResolvedValueOnce({
        result: "conflict",
        memo: { ...savedView, body: "somebody else wrote this", version: 5 },
        conflict: {
          currentBody: "somebody else wrote this",
          currentVersion: 5,
          latestRevision: {
            revisionNumber: 4,
            actor: { kind: "aiClient", clientName: "Claude" },
            createdAt: new Date("2026-01-02T03:04:00Z"),
          },
        },
      })
      .mockResolvedValueOnce({
        result: "saved",
        memo: { ...savedView, body: "mine", version: 6 },
        conflict: null,
      });
    await renderWithRouter(<MemoEntry memo={item} />);
    const { form, textarea, save } = startEditing();
    fireEvent.change(textarea, { target: { value: "mine" } });
    fireEvent.submit(form);

    const alert = await screen.findByRole("alert");
    await waitFor(() => {
      expect(alert.textContent).toContain("Claude");
      expect(alert.textContent).toContain("somebody else wrote this");
      expect(save().textContent).toBe("そのまま保存");
    });
    expect(screen.getByRole("form", { name: "メモを編集" })).toBeTruthy();
    expect(
      (within(form).getByLabelText("本文") as HTMLTextAreaElement).value,
    ).toBe("mine");

    fireEvent.submit(form);
    await waitFor(() =>
      expect(mocks.editMemoFn).toHaveBeenLastCalledWith({
        data: { memoId: "m1", body: "mine", expectedVersion: 5 },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "メモを編集" })).toBeNull(),
    );
  });

  it("keeps the editor and the draft on a rejection", async () => {
    mocks.editMemoFn.mockRejectedValue(
      new AppServerError({
        kind: "business",
        code: "EMPTY_BODY",
        message: "x",
      }),
    );
    await renderWithRouter(<MemoEntry memo={item} />);
    const { form, textarea } = startEditing();
    fireEvent.change(textarea, { target: { value: "will fail" } });
    fireEvent.submit(form);
    const alert = await screen.findByRole("alert");
    await waitFor(() =>
      expect(alert.textContent).toBe("メモを入力してください"),
    );
    expect(screen.getByRole("form", { name: "メモを編集" })).toBeTruthy();
    expect(
      (within(form).getByLabelText("本文") as HTMLTextAreaElement).value,
    ).toBe("will fail");
  });

  it("discards the draft on cancel", async () => {
    await renderWithRouter(<MemoEntry memo={item} />);
    const { form, textarea } = startEditing();
    fireEvent.change(textarea, { target: { value: "discarded" } });
    fireEvent.click(within(form).getByRole("button", { name: "取り消し" }));
    expect(screen.queryByRole("form", { name: "メモを編集" })).toBeNull();
    expect(screen.getByText("original body")).toBeTruthy();
    expect(screen.queryByText("discarded")).toBeNull();
    expect(mocks.editMemoFn).not.toHaveBeenCalled();
  });
});

describe("MemoEntry source-document trail", () => {
  it("draws the trail with a live link and a disabled trashed entry", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <MemoEntry
        memo={{
          ...memo("cited", new Date(0)),
          sourceDocuments: [
            { documentId: "d1", title: "設計メモ", isTrashed: false },
            { documentId: "d2", title: "x", isTrashed: true },
          ],
        }}
      />,
    );
    const nav = screen.getByRole("navigation", {
      name: "出典になっているドキュメント",
    });
    expect(
      within(nav)
        .getByRole("link", { name: /設計メモ/ })
        .getAttribute("href"),
    ).toBe("/documents/d1");
    expect(nav.querySelector('[aria-disabled="true"]')?.textContent).toContain(
      "削除済みのドキュメント",
    );
    expectInternalHrefsToResolve();
  });

  it("draws no trail for a memo nothing cites", async () => {
    await renderWithRouter(<MemoEntry memo={memo("plain", new Date(0))} />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
