import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
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

describe("TopicHeader", () => {
  it("shows the name, the badge when archived and the description, with 削除 apart", async () => {
    await renderWithRouter(
      <TopicHeader
        topic={topicView("t1", "読書メモ", {
          description: "本の要約",
          status: "archived",
        })}
      />,
      { path: "/topics/$topicId" },
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain(
      "読書メモ",
    );
    expect(screen.getByText("完了")).toBeTruthy();
    expect(screen.getByText("本の要約")).toBeTruthy();
    const menu = openMenu();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["編集", "完了を解除", "削除"]);
    const children = [...menu.children];
    const separator = children.findIndex((c) => c.tagName === "HR");
    expect(separator).toBeGreaterThan(0);
    expect(children[separator + 1]?.textContent).toBe("削除");
  });

  it("edits inline: prefilled, blank name disables, saves with an optimistic name and invalidates", async () => {
    const update = deferred<unknown>();
    mocks.updateTopicFn.mockReturnValue(update.promise);
    const { router } = await renderWithRouter(
      <TopicHeader topic={topicView("t1", "前", { description: "説明" })} />,
      { path: "/topics/$topicId" },
    );
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "編集" }));
    const form = screen.getByRole("form", { name: "トピックを編集" });
    const name = within(form).getByLabelText("名前") as HTMLInputElement;
    const description = within(form).getByLabelText(
      "説明",
    ) as HTMLTextAreaElement;
    expect(name.value).toBe("前");
    expect(description.value).toBe("説明");
    fireEvent.change(name, { target: { value: "   " } });
    expect(
      (within(form).getByRole("button", { name: "保存" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(name, { target: { value: "後" } });
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
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain(
      "前",
    );
  });

  it("restores the fields on 取り消し", async () => {
    await renderWithRouter(<TopicHeader topic={topicView("t1", "前")} />, {
      path: "/topics/$topicId",
    });
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "編集" }));
    const form = screen.getByRole("form", { name: "トピックを編集" });
    fireEvent.change(within(form).getByLabelText("名前"), {
      target: { value: "破棄" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "取り消し" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain(
      "前",
    );
    expect(mocks.updateTopicFn).not.toHaveBeenCalled();
  });

  it("archives and unarchives with an optimistic badge", async () => {
    const update = deferred<unknown>();
    mocks.updateTopicFn.mockReturnValue(update.promise);
    await renderWithRouter(<TopicHeader topic={topicView("t1", "x")} />, {
      path: "/topics/$topicId",
    });
    fireEvent.click(
      within(openMenu()).getByRole("menuitem", { name: "完了にする" }),
    );
    await screen.findByText("完了");
    expect(mocks.updateTopicFn).toHaveBeenCalledWith({
      data: { topicId: "t1", archived: true },
    });
    update.resolve(topicView("t1", "x", { status: "archived" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    mocks.updateTopicFn.mockResolvedValue(topicView("t1", "x"));
    await renderWithRouter(
      <TopicHeader topic={topicView("t2", "y", { status: "archived" })} />,
      {
        path: "/topics/$topicId",
      },
    );
    const buttons = screen.getAllByRole("button", { name: "トピックの操作" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "完了を解除" }));
    await waitFor(() =>
      expect(mocks.updateTopicFn).toHaveBeenCalledWith({
        data: { topicId: "t2", archived: false },
      }),
    );
  });

  it("shows the rejection as an alert", async () => {
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
    fireEvent.click(
      within(openMenu()).getByRole("menuitem", { name: "完了にする" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "他の操作と競合しました。もう一度お試しください",
    );
  });

  it("deletes behind a confirmation and leaves for the list; cancel calls nothing", async () => {
    mocks.trashTopicFn.mockResolvedValue({
      topicId: "t1",
      trashedDocumentIds: ["d1"],
    });
    const { router } = await renderWithRouter(
      <TopicHeader topic={topicView("t1", "x")} />,
      {
        path: "/topics/$topicId",
      },
    );
    const navigate = vi.spyOn(router, "navigate");
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
  });
});
