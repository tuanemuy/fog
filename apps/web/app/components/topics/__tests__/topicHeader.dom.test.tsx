import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateFilter,
  renderWithRouter,
} from "@/components/__tests__/renderWithRouter";
import { TopicHeader } from "@/components/topics/TopicHeader";
import { AppServerError } from "@/presentation/errorResponse";
import { deferred, topicView } from "./fixtures";

const mocks = vi.hoisted(() => ({
  createTopicFn: vi.fn(),
  updateTopicFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  trashTopicFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/topics/actions", () => ({
  createTopicFn: mocks.createTopicFn,
  updateTopicFn: mocks.updateTopicFn,
  trashTopicFn: mocks.trashTopicFn,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "トピックの操作" }));
  return screen.getByRole("menu");
}

function openEditor() {
  fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "編集" }));
  const form = screen.getByRole("form", { name: "トピックを編集" });
  return {
    form,
    name: within(form).getByLabelText("トピック名") as HTMLInputElement,
    description: within(form).getByLabelText("説明") as HTMLTextAreaElement,
    save: within(form).getByRole("button", {
      name: /^保存(中…)?$/,
    }) as HTMLButtonElement,
  };
}

const glyphOf = (button: HTMLElement) =>
  button.querySelector("svg")?.getAttribute("data-icon");

describe("TopicHeader", () => {
  it("shows the name and the description; 完了にする is a button under them and never a menu item", async () => {
    await renderWithRouter(
      <TopicHeader
        topic={topicView("t1", "読書メモ", { description: "本の要約" })}
      />,
      { path: "/topics/$topicId" },
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "読書メモ",
    );
    expect(screen.getByText("本の要約")).toBeTruthy();
    expect(screen.queryByText("完了済み")).toBeNull();
    const complete = screen.getByRole("button", { name: "完了にする" });
    expect(glyphOf(complete)).toBe("check");
    const menu = openMenu();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["編集", "削除"]);
    expect(within(menu).queryByText(/完了/)).toBeNull();
  });

  it("marks an archived topic 完了済み and offers 完了を解除 in the same place", async () => {
    await renderWithRouter(
      <TopicHeader
        topic={topicView("t1", "確定申告", { status: "archived" })}
      />,
      { path: "/topics/$topicId" },
    );
    const undo = screen.getByRole("button", { name: "完了を解除" });
    expect(glyphOf(undo)).toBe("restore");
    const mark = screen.getByText("完了済み");
    expect(mark.parentElement).toBe(undo.parentElement);
    expect(screen.queryByRole("button", { name: "完了にする" })).toBeNull();
  });

  it("draws no description line without one", async () => {
    const { container } = await renderWithRouter(
      <TopicHeader topic={topicView("t1", "説明なし")} />,
      { path: "/topics/$topicId" },
    );
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("edits in place: prefilled and focused, a blank name is refused with its message, saves with an optimistic name and invalidates", async () => {
    const update = deferred<unknown>();
    mocks.updateTopicFn.mockReturnValue(update.promise);
    const { router } = await renderWithRouter(
      <TopicHeader topic={topicView("t1", "前", { description: "説明" })} />,
      { path: "/topics/$topicId" },
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { form, name, description, save } = openEditor();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.activeElement).toBe(name);
    expect(name.value).toBe("前");
    expect(description.value).toBe("説明");
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.submit(form);
    const alert = within(form).getByRole("alert");
    expect(alert.textContent).toBe("トピック名を入力してください");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe(alert.id);
    expect(save.disabled).toBe(true);
    expect(mocks.updateTopicFn).not.toHaveBeenCalled();
    expect(screen.getByRole("form", { name: "トピックを編集" })).toBe(form);
    fireEvent.change(name, { target: { value: "後" } });
    expect(within(form).queryByRole("alert")).toBeNull();
    expect(save.disabled).toBe(false);
    fireEvent.change(description, { target: { value: "" } });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(mocks.updateTopicFn).toHaveBeenCalledWith({
        data: { topicId: "t1", name: "後", description: null },
      }),
    );
    expect(invalidate).not.toHaveBeenCalled();
    update.resolve(topicView("t1", "後"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    // The prop is what the refetched loader hands down; the harness never
    // refetches, so the header settles back on 「前」.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("前");
  });

  it("keeps the form open with the rejection at its head when the save fails", async () => {
    mocks.updateTopicFn.mockRejectedValue(
      new AppServerError({
        kind: "conflict",
        code: "OPTIMISTIC_LOCK_FAILURE",
        message: "x",
      }),
    );
    await renderWithRouter(<TopicHeader topic={topicView("t1", "前")} />, {
      path: "/topics/$topicId",
    });
    const { form, name } = openEditor();
    fireEvent.change(name, { target: { value: "後" } });
    fireEvent.submit(form);
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(
      "他の操作と競合しました。もう一度お試しください",
    );
    expect(form.firstElementChild).toBe(alert);
    expect(
      (within(form).getByLabelText("トピック名") as HTMLInputElement).value,
    ).toBe("後");
  });

  it("restores the fields on キャンセル", async () => {
    await renderWithRouter(<TopicHeader topic={topicView("t1", "前")} />, {
      path: "/topics/$topicId",
    });
    const { form, name } = openEditor();
    fireEvent.change(name, { target: { value: "破棄" } });
    fireEvent.click(within(form).getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("前");
    expect(openEditor().name.value).toBe("前");
    expect(mocks.updateTopicFn).not.toHaveBeenCalled();
  });

  it("archives and unarchives with an optimistic 完了済み", async () => {
    const update = deferred<unknown>();
    mocks.updateTopicFn.mockReturnValue(update.promise);
    await renderWithRouter(<TopicHeader topic={topicView("t1", "x")} />, {
      path: "/topics/$topicId",
    });
    fireEvent.click(screen.getByRole("button", { name: "完了にする" }));
    await screen.findByText("完了済み");
    expect(screen.getByRole("button", { name: "完了を解除" })).toBeTruthy();
    expect(mocks.updateTopicFn).toHaveBeenCalledWith({
      data: { topicId: "t1", archived: true },
    });
    update.resolve(topicView("t1", "x", { status: "archived" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    mocks.updateTopicFn.mockResolvedValue(topicView("t1", "x"));
    await renderWithRouter(
      <TopicHeader topic={topicView("t2", "y", { status: "archived" })} />,
      { path: "/topics/$topicId" },
    );
    const buttons = screen.getAllByRole("button", { name: "完了を解除" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() =>
      expect(mocks.updateTopicFn).toHaveBeenCalledWith({
        data: { topicId: "t2", archived: false },
      }),
    );
  });

  it("tells a rejected archive under the head", async () => {
    mocks.updateTopicFn.mockRejectedValue(
      new AppServerError({
        kind: "conflict",
        code: "OPTIMISTIC_LOCK_FAILURE",
        message: "x",
      }),
    );
    await renderWithRouter(<TopicHeader topic={topicView("t1", "x")} />, {
      path: "/topics/$topicId",
    });
    fireEvent.click(screen.getByRole("button", { name: "完了にする" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "他の操作と競合しました。もう一度お試しください",
    );
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("deletes behind a confirmation and leaves for the list; cancel calls nothing", async () => {
    mocks.trashTopicFn.mockResolvedValue({
      topicId: "t1",
      trashedDocumentIds: ["d1"],
    });
    const { router } = await renderWithRouter(
      <TopicHeader topic={topicView("t1", "x")} />,
      { path: "/topics/$topicId" },
    );
    const navigate = vi.spyOn(router, "navigate");
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "削除" }));
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "トピックを削除しますか？",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.trashTopicFn).not.toHaveBeenCalled();

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "削除" }));
    dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "削除" }));
    await waitFor(() =>
      expect(mocks.trashTopicFn).toHaveBeenCalledWith({
        data: { topicId: "t1" },
      }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/topics" }),
    );
    // The topic list is cached with this topic still on it.
    expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0] ?? 0,
    );
    // ...and it marks the list without re-reading the screen just deleted,
    // whose loader would draw 「トピックが見つかりません」.
    const filter = invalidateFilter(invalidate);
    expect(filter?.({ routeId: "/_app/topics_/$topicId" })).toBe(false);
    expect(filter?.({ routeId: "/_app/topics" })).toBe(true);
  });

  it("keeps a confirmed delete from being told as failed when the reconciliation fails", async () => {
    const trash = deferred<unknown>();
    mocks.trashTopicFn.mockReturnValue(trash.promise);
    const { router } = await renderWithRouter(
      <TopicHeader topic={topicView("t1", "x")} />,
      { path: "/topics/$topicId" },
    );
    vi.spyOn(router, "invalidate").mockRejectedValue(
      new AppServerError({
        kind: "system",
        code: "X",
        message: "x",
        retryable: true,
      }),
    );
    const navigate = vi.spyOn(router, "navigate");
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "削除" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "削除" }),
    );
    await screen.findByRole("button", { name: "削除中…" });
    trash.resolve({ topicId: "t1", trashedDocumentIds: [] });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "削除中…" })).toBeNull(),
    );
    // The topic is in the trash; a failure told here would describe the
    // re-read, not the delete.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("tells a rejected delete under the head and stays", async () => {
    mocks.trashTopicFn.mockRejectedValue(
      new AppServerError({
        kind: "system",
        code: "X",
        message: "x",
        retryable: true,
      }),
    );
    const { router } = await renderWithRouter(
      <TopicHeader topic={topicView("t1", "x")} />,
      { path: "/topics/$topicId" },
    );
    const navigate = vi.spyOn(router, "navigate");
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "削除" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "削除" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("システムエラーが発生しました");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(navigate).not.toHaveBeenCalled();
  });
});
