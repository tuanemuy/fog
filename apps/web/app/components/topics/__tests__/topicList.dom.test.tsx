import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { TopicList } from "@/components/topics/TopicList";
import { AppServerError } from "@/presentation/errorResponse";
import { deferred, topic, topicView } from "./fixtures";

const mocks = vi.hoisted(() => ({
  createTopicFn: vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  updateTopicFn: vi.fn(),
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

function composer() {
  const form = screen.getByRole("form", { name: "新しいトピック" });
  return {
    form,
    input: within(form).getByLabelText(
      "新しいトピックの名前",
    ) as HTMLInputElement,
    submit: within(form).getByRole("button", {
      name: /^追加(中…)?$/,
    }) as HTMLButtonElement,
  };
}

function rowNames(): string[] {
  return [...document.querySelectorAll(".fog-topic-row")].map(
    (row) =>
      row.querySelector(".fog-topic-name")?.childNodes[0]?.textContent ?? "",
  );
}

describe("TopicList: create", () => {
  it("draws the empty state; a blank name says so, posts nothing and keeps the description", async () => {
    mocks.createTopicFn.mockResolvedValue(topicView("t1", "補充後トピック"));
    await renderWithRouter(<TopicList initial={{ topics: [] }} />, {
      path: "/topics",
    });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "最初のトピックを作ろう",
    );
    fireEvent.click(screen.getByRole("button", { name: "説明を追加" }));
    fireEvent.change(screen.getByLabelText("説明"), {
      target: { value: "説明のみ" },
    });
    const { input, submit } = composer();
    expect(submit.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.click(submit);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("トピック名を入力してください");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(mocks.createTopicFn).not.toHaveBeenCalled();
    expect((screen.getByLabelText("説明") as HTMLTextAreaElement).value).toBe(
      "説明のみ",
    );

    fireEvent.change(input, { target: { value: "補充後トピック" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    fireEvent.click(composer().submit);
    await waitFor(() =>
      expect(mocks.createTopicFn).toHaveBeenCalledWith({
        data: { name: "補充後トピック", description: "説明のみ" },
      }),
    );
  });

  it("reveals the description textarea behind 説明を追加 and posts it", async () => {
    mocks.createTopicFn.mockResolvedValue(topicView("t1", "読書"));
    await renderWithRouter(<TopicList initial={{ topics: [] }} />, {
      path: "/topics",
    });
    expect(screen.queryByLabelText("説明")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "説明を追加" }));
    fireEvent.change(screen.getByLabelText("説明"), {
      target: { value: " 本の要約 " },
    });
    fireEvent.change(composer().input, { target: { value: "読書" } });
    fireEvent.click(composer().submit);
    await waitFor(() =>
      expect(mocks.createTopicFn).toHaveBeenCalledWith({
        data: { name: "読書", description: "本の要約" },
      }),
    );
  });

  it("shows the optimistic row before the post settles, then clears the inputs", async () => {
    const post = deferred<unknown>();
    mocks.createTopicFn.mockReturnValue(post.promise);
    const { router } = await renderWithRouter(
      <TopicList initial={{ topics: [topic("t0", "既存")] }} />,
      { path: "/topics" },
    );
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.change(composer().input, { target: { value: "新しいトピック" } });
    fireEvent.click(composer().submit);

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("保存中…");
    const row = status.closest(".fog-topic-row");
    expect(row?.getAttribute("aria-busy")).toBe("true");
    expect(rowNames()[0]).toBe("新しいトピック");
    expect(mocks.createTopicFn).toHaveBeenCalledWith({
      data: { name: "新しいトピック", description: null },
    });
    expect(invalidate).not.toHaveBeenCalled();

    post.resolve(topicView("t1", "新しいトピック"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(composer().input.value).toBe(""));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the inputs and shows the message when the post fails", async () => {
    mocks.createTopicFn.mockRejectedValue(
      new AppServerError({
        kind: "business",
        code: "EMPTY_TOPIC_NAME",
        message: "x",
      }),
    );
    const { router } = await renderWithRouter(
      <TopicList initial={{ topics: [] }} />,
      {
        path: "/topics",
      },
    );
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.change(composer().input, { target: { value: "x" } });
    fireEvent.click(composer().submit);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("トピック名を入力してください");
    expect(composer().input.value).toBe("x");
    expect(invalidate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("treats a resolved value of the wrong shape as a system error", async () => {
    mocks.createTopicFn.mockResolvedValue({ status: 500, unhandled: true });
    await renderWithRouter(<TopicList initial={{ topics: [] }} />, {
      path: "/topics",
    });
    fireEvent.change(composer().input, { target: { value: "x" } });
    fireEvent.click(composer().submit);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    expect(composer().input.value).toBe("x");
  });

  it("posts once when the form is submitted twice in the same frame", async () => {
    const post = deferred<unknown>();
    mocks.createTopicFn.mockReturnValue(post.promise);
    await renderWithRouter(<TopicList initial={{ topics: [] }} />, {
      path: "/topics",
    });
    const { input, form } = composer();
    fireEvent.change(input, { target: { value: "twice" } });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByRole("status");
    post.resolve(topicView("t1", "twice"));
    await waitFor(() => expect(composer().input.value).toBe(""));
    expect(mocks.createTopicFn).toHaveBeenCalledTimes(1);
  });
});

describe("TopicList: sections", () => {
  it("folds archived topics under a collapsed toggle and shows none without them", async () => {
    await renderWithRouter(
      <TopicList
        initial={{
          topics: [
            topic("a", "進行中"),
            topic("b", "完了した", { status: "archived" }),
            topic("c", "完了した 2", { status: "archived" }),
          ],
        }}
      />,
      { path: "/topics" },
    );
    expect(rowNames()).toEqual(["進行中"]);
    const toggle = screen.getByRole("button", { name: "完了済み（2）" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rowNames()).toEqual(["進行中", "完了した", "完了した 2"]);
    expect(screen.getByLabelText("完了済みのトピック")).toBeTruthy();
  });

  it("draws no toggle when no topic is archived", async () => {
    await renderWithRouter(
      <TopicList initial={{ topics: [topic("a", "進行中")] }} />,
      {
        path: "/topics",
      },
    );
    expect(screen.queryByRole("button", { name: /完了済み/ })).toBeNull();
  });
});

describe("TopicList: delete is owned by the list", () => {
  function openDelete(name: string) {
    const row = [...document.querySelectorAll(".fog-topic-row")].find((r) =>
      r.textContent?.includes(name),
    ) as HTMLElement;
    fireEvent.click(
      within(row).getByRole("button", { name: "トピックの操作" }),
    );
    fireEvent.click(within(row).getByRole("menuitem", { name: "削除" }));
    return screen.getByRole("dialog");
  }

  it("keeps the row and calls nothing on cancel", async () => {
    await renderWithRouter(
      <TopicList initial={{ topics: [topic("a", "残る")] }} />,
      {
        path: "/topics",
      },
    );
    const dialog = openDelete("残る");
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "トピックを削除しますか？",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rowNames()).toEqual(["残る"]);
    expect(mocks.trashTopicFn).not.toHaveBeenCalled();
  });

  it("removes the row immediately and invalidates once the server confirms", async () => {
    const trash = deferred<unknown>();
    mocks.trashTopicFn.mockReturnValue(trash.promise);
    const { router } = await renderWithRouter(
      <TopicList
        initial={{ topics: [topic("a", "消える"), topic("b", "残る")] }}
      />,
      { path: "/topics" },
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const dialog = openDelete("消える");
    fireEvent.click(within(dialog).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(rowNames()).toEqual(["残る"]));
    expect(mocks.trashTopicFn).toHaveBeenCalledWith({ data: { topicId: "a" } });
    expect(invalidate).not.toHaveBeenCalled();
    trash.resolve({ topicId: "a", trashedDocumentIds: [] });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(rowNames()).toEqual(["残る"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("restores the row on failure and offers a retry that calls again", async () => {
    mocks.trashTopicFn.mockRejectedValueOnce(
      new AppServerError({
        kind: "system",
        code: "X",
        message: "x",
        retryable: true,
      }),
    );
    await renderWithRouter(
      <TopicList initial={{ topics: [topic("a", "戻る")] }} />,
      {
        path: "/topics",
      },
    );
    const dialog = openDelete("戻る");
    fireEvent.click(within(dialog).getByRole("button", { name: "削除" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("システムエラーが発生しました");
    await waitFor(() => expect(rowNames()).toEqual(["戻る"]));
    mocks.trashTopicFn.mockResolvedValueOnce({
      topicId: "a",
      trashedDocumentIds: [],
    });
    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(mocks.trashTopicFn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowNames()).toEqual([]));
  });
});
