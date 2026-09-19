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

const EMPTY = "最初のトピックを作ってみましょう";

const addButton = () => screen.getByRole("button", { name: "新しいトピック" });

function openForm() {
  fireEvent.click(addButton());
  return composer();
}

function composer() {
  const form = screen.getByRole("form", { name: "新しいトピック" });
  return {
    form,
    input: within(form).getByLabelText("トピック名") as HTMLInputElement,
    description: within(form).getByLabelText(
      "説明（任意）",
    ) as HTMLTextAreaElement,
    submit: within(form).getByRole("button", {
      name: /^追加(中…)?$/,
    }) as HTMLButtonElement,
    cancel: within(form).getByRole("button", {
      name: "キャンセル",
    }) as HTMLButtonElement,
  };
}

/** The list items that hold a topic — not the one that adds the next. */
function topicItems(): HTMLElement[] {
  return screen
    .queryAllByRole("listitem")
    .filter(
      (item) =>
        within(item).queryByRole("button", { name: "新しいトピック" }) ===
          null &&
        within(item).queryByRole("form", { name: "新しいトピック" }) === null,
    );
}

/** Each topic item's name, the first text of its first line. */
function rowNames(): string[] {
  return topicItems().map(
    (item) => item.querySelector("span")?.childNodes[0]?.textContent ?? "",
  );
}

function itemOf(name: string): HTMLElement {
  const item = topicItems().find(
    (candidate) =>
      candidate.querySelector("span")?.childNodes[0]?.textContent === name,
  );
  if (item === undefined) throw new Error(`no row for ${name}`);
  return item;
}

describe("TopicList: create", () => {
  it("draws the one-sentence empty state and ends the list in 新しいトピック", async () => {
    await renderWithRouter(<TopicList initial={{ topics: [] }} />, {
      path: "/topics",
    });
    const sentence = screen.getByText(EMPTY);
    expect(sentence.tagName).toBe("P");
    expect(screen.queryByRole("heading")).toBeNull();
    const list = screen.getByRole("list", { name: "進行中のトピック" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByRole("button", { name: "新しいトピック" })).toBe(
      addButton(),
    );
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("draws no empty state while there is a topic", async () => {
    await renderWithRouter(
      <TopicList initial={{ topics: [topic("a", "進行中")] }} />,
      { path: "/topics" },
    );
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(rowNames()).toEqual(["進行中"]);
  });

  it("turns 新しいトピック into the form in its place, and キャンセル turns it back with the draft gone", async () => {
    await renderWithRouter(<TopicList initial={{ topics: [] }} />, {
      path: "/topics",
    });
    const { input, description, cancel } = openForm();
    expect(screen.queryByRole("button", { name: "新しいトピック" })).toBeNull();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "書きかけ" } });
    fireEvent.change(description, { target: { value: "説明" } });
    fireEvent.click(cancel);
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(addButton());
    const reopened = openForm();
    expect(reopened.input.value).toBe("");
    expect(reopened.description.value).toBe("");
    expect(mocks.createTopicFn).not.toHaveBeenCalled();
  });

  it("refuses a blank name with its message, holds 追加 until a name is typed, and keeps the description", async () => {
    mocks.createTopicFn.mockResolvedValue(topicView("t1", "補充後トピック"));
    await renderWithRouter(<TopicList initial={{ topics: [] }} />, {
      path: "/topics",
    });
    const { input, description, submit } = openForm();
    fireEvent.change(description, { target: { value: "説明のみ" } });
    expect(submit.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.click(submit);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("トピック名を入力してください");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(submit.disabled).toBe(true);
    expect(mocks.createTopicFn).not.toHaveBeenCalled();
    expect(description.value).toBe("説明のみ");

    fireEvent.change(input, { target: { value: "補充後トピック" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(submit.disabled).toBe(false);
    fireEvent.click(composer().submit);
    await waitFor(() =>
      expect(mocks.createTopicFn).toHaveBeenCalledWith({
        data: { name: "補充後トピック", description: "説明のみ" },
      }),
    );
  });

  it("posts the trimmed description, and null for none", async () => {
    mocks.createTopicFn.mockResolvedValue(topicView("t1", "読書"));
    await renderWithRouter(<TopicList initial={{ topics: [] }} />, {
      path: "/topics",
    });
    const first = openForm();
    fireEvent.change(first.description, { target: { value: " 本の要約 " } });
    fireEvent.change(first.input, { target: { value: "読書" } });
    fireEvent.click(first.submit);
    await waitFor(() =>
      expect(mocks.createTopicFn).toHaveBeenCalledWith({
        data: { name: "読書", description: "本の要約" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    const second = openForm();
    fireEvent.change(second.input, { target: { value: "旅行" } });
    fireEvent.click(second.submit);
    await waitFor(() =>
      expect(mocks.createTopicFn).toHaveBeenLastCalledWith({
        data: { name: "旅行", description: null },
      }),
    );
  });

  it("shows the optimistic row first in the list before the post settles, then puts 新しいトピック back", async () => {
    const post = deferred<unknown>();
    mocks.createTopicFn.mockReturnValue(post.promise);
    const { router } = await renderWithRouter(
      <TopicList initial={{ topics: [topic("t0", "既存")] }} />,
      { path: "/topics" },
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { input, submit } = openForm();
    fireEvent.change(input, { target: { value: "新しい話題" } });
    fireEvent.click(submit);

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("保存中…");
    expect(rowNames()).toEqual(["新しい話題", "既存"]);
    const pendingItem = itemOf("新しい話題");
    expect(pendingItem.contains(status)).toBe(true);
    expect(pendingItem.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(within(pendingItem).queryByRole("link")).toBeNull();
    expect(mocks.createTopicFn).toHaveBeenCalledWith({
      data: { name: "新しい話題", description: null },
    });
    expect(invalidate).not.toHaveBeenCalled();

    post.resolve(topicView("t1", "新しい話題"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(document.activeElement).toBe(addButton());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the form and its inputs and puts the rejection at the head of the form", async () => {
    mocks.createTopicFn.mockRejectedValue(
      new AppServerError({
        kind: "business",
        code: "EMPTY_TOPIC_NAME",
        message: "x",
      }),
    );
    const { router } = await renderWithRouter(
      <TopicList initial={{ topics: [] }} />,
      { path: "/topics" },
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { input, submit } = openForm();
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.click(submit);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("トピック名を入力してください");
    const { form } = composer();
    expect(form.firstElementChild).toBe(alert);
    expect(composer().input.value).toBe("x");
    expect(invalidate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("drops a rejection dismissed with キャンセル, and shows the next one", async () => {
    mocks.createTopicFn.mockRejectedValue(
      new AppServerError({
        kind: "system",
        code: "X",
        message: "x",
        retryable: true,
      }),
    );
    await renderWithRouter(<TopicList initial={{ topics: [] }} />, {
      path: "/topics",
    });
    const first = openForm();
    fireEvent.change(first.input, { target: { value: "x" } });
    fireEvent.click(first.submit);
    await screen.findByRole("alert");
    fireEvent.click(composer().cancel);
    const second = openForm();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(second.input, { target: { value: "y" } });
    fireEvent.click(second.submit);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "システムエラーが発生しました",
    );
  });

  it("treats a resolved value of the wrong shape as a system error", async () => {
    mocks.createTopicFn.mockResolvedValue({ status: 500, unhandled: true });
    await renderWithRouter(<TopicList initial={{ topics: [] }} />, {
      path: "/topics",
    });
    const { input, submit } = openForm();
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.click(submit);
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
    const { input, form } = openForm();
    fireEvent.change(input, { target: { value: "twice" } });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByRole("status");
    post.resolve(topicView("t1", "twice"));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(mocks.createTopicFn).toHaveBeenCalledTimes(1);
  });
});

describe("TopicList: sections", () => {
  it("folds archived topics under a collapsed toggle, drawn without their description", async () => {
    await renderWithRouter(
      <TopicList
        initial={{
          topics: [
            topic("a", "進行中", { description: "進行中の説明" }),
            topic("b", "完了した", {
              status: "archived",
              description: "完了した説明",
            }),
            topic("c", "完了した 2", { status: "archived" }),
          ],
        }}
      />,
      { path: "/topics" },
    );
    expect(rowNames()).toEqual(["進行中"]);
    const toggle = screen.getByRole("button", { name: "完了済み（2）" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    expect(
      screen.queryByRole("list", { name: "完了済みのトピック" }),
    ).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const archivedList = screen.getByRole("list", {
      name: "完了済みのトピック",
    });
    const controlled = document.getElementById(
      toggle.getAttribute("aria-controls") ?? "",
    );
    expect(controlled?.contains(archivedList)).toBe(true);
    expect(rowNames()).toEqual(["進行中", "完了した", "完了した 2"]);
    expect(screen.getByText("進行中の説明")).toBeTruthy();
    expect(screen.queryByText("完了した説明")).toBeNull();
  });

  it("draws no toggle when no topic is archived", async () => {
    await renderWithRouter(
      <TopicList initial={{ topics: [topic("a", "進行中")] }} />,
      { path: "/topics" },
    );
    expect(screen.queryByRole("button", { name: /完了済み/ })).toBeNull();
  });
});

describe("TopicList: delete is owned by the list", () => {
  function openDelete(name: string) {
    const item = itemOf(name);
    fireEvent.click(
      within(item).getByRole("button", { name: "トピックの操作" }),
    );
    fireEvent.click(within(item).getByRole("menuitem", { name: "削除" }));
    return screen.getByRole("dialog");
  }

  it("keeps the row and calls nothing on cancel", async () => {
    await renderWithRouter(
      <TopicList initial={{ topics: [topic("a", "残る")] }} />,
      { path: "/topics" },
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

  it("puts the row back with the failure under it, and リトライ calls again", async () => {
    mocks.trashTopicFn.mockRejectedValueOnce(
      new AppServerError({
        kind: "system",
        code: "X",
        message: "x",
        retryable: true,
      }),
    );
    await renderWithRouter(
      <TopicList
        initial={{ topics: [topic("a", "戻る"), topic("b", "隣")] }}
      />,
      { path: "/topics" },
    );
    const dialog = openDelete("戻る");
    fireEvent.click(within(dialog).getByRole("button", { name: "削除" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("システムエラーが発生しました");
    await waitFor(() => expect(rowNames()).toEqual(["戻る", "隣"]));
    const failed = itemOf("戻る");
    expect(failed.contains(alert)).toBe(true);
    expect(
      within(failed).getByRole("link", { name: /戻る/ }).contains(alert),
    ).toBe(false);
    expect(within(itemOf("隣")).queryByRole("alert")).toBeNull();
    mocks.trashTopicFn.mockResolvedValueOnce({
      topicId: "a",
      trashedDocumentIds: [],
    });
    fireEvent.click(within(alert).getByRole("button", { name: "リトライ" }));
    await waitFor(() => expect(mocks.trashTopicFn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowNames()).toEqual(["隣"]));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
