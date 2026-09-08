import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { TopicRow } from "@/components/topics/TopicRow";
import { topic } from "./fixtures";

afterEach(() => {
  vi.clearAllMocks();
});

describe("TopicRow", () => {
  it("links to the detail with the name, the count and the description", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <TopicRow
        topic={topic("t1", "読書メモ", {
          description: "本の要約",
          documents: [
            { id: "d1", title: "a", updatedAt: new Date(0) },
            { id: "d2", title: "b", updatedAt: new Date(0) },
          ],
        })}
        onDelete={vi.fn()}
      />,
      { path: "/topics" },
    );
    const link = screen.getByRole("link", { name: /読書メモ/ });
    expect(link.getAttribute("href")).toBe("/topics/t1");
    expect(document.querySelector(".fog-topic-count")?.textContent).toBe(
      "ドキュメント数: 2",
    );
    expect(screen.getByText("本の要約")).toBeTruthy();
    expectInternalHrefsToResolve();
  });

  it("opens the menu with 編集 / 削除, navigates on 編集 and delegates 削除", async () => {
    const onDelete = vi.fn();
    const t = topic("t1", "読書メモ");
    const { router } = await renderWithRouter(
      <TopicRow topic={t} onDelete={onDelete} />,
      {
        path: "/topics",
      },
    );
    const navigate = vi.spyOn(router, "navigate");
    const button = screen.getByRole("button", { name: "トピックの操作" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "編集",
      "削除",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "編集" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/topics/$topicId",
      params: { topicId: "t1" },
    });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    expect(onDelete).toHaveBeenCalledWith(t);
  });

  it("opens on right click and closes on Escape", async () => {
    await renderWithRouter(
      <TopicRow topic={topic("t1", "x")} onDelete={vi.fn()} />,
      {
        path: "/topics",
      },
    );
    const row = document.querySelector(".fog-topic-row-main") as HTMLElement;
    fireEvent.contextMenu(row);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("draws a pending row without a menu and with the saving status", async () => {
    await renderWithRouter(
      <TopicRow
        topic={{ ...topic("p", "保存中の行"), pending: true }}
        onDelete={vi.fn()}
      />,
      { path: "/topics" },
    );
    expect(screen.getByRole("status").textContent).toBe("保存中…");
    expect(screen.queryByRole("button", { name: "トピックの操作" })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      document.querySelector(".fog-topic-row")?.getAttribute("aria-busy"),
    ).toBe("true");
  });
});
