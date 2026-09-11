import { fireEvent, screen, within } from "@testing-library/react";
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
    expect(
      within(link).getByText("ドキュメント数:").parentElement?.textContent,
    ).toBe("ドキュメント数: 2");
    expect(within(link).getByText("本の要約")).toBeTruthy();
    expectInternalHrefsToResolve();
  });

  it("sets an archived topic neutral and leaves its description out", async () => {
    await renderWithRouter(
      <>
        <TopicRow
          topic={topic("t1", "完了した", {
            status: "archived",
            description: "書かない説明",
          })}
          onDelete={vi.fn()}
        />
        <TopicRow
          topic={topic("t2", "進行中", { description: "書く説明" })}
          onDelete={vi.fn()}
        />
      </>,
      { path: "/topics" },
    );
    expect(screen.queryByText("書かない説明")).toBeNull();
    expect(screen.getByText("書く説明")).toBeTruthy();
    const neutral = (name: string) =>
      screen.getByText(name).classList.contains("text-neutral-600");
    expect(neutral("完了した")).toBe(true);
    expect(neutral("進行中")).toBe(false);
  });

  it("opens its menu with 編集 (a link to the detail) and 削除, which it hands to the owner", async () => {
    const onDelete = vi.fn();
    const t = topic("t1", "読書メモ");
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <TopicRow topic={t} onDelete={onDelete} />,
      { path: "/topics" },
    );
    const button = screen.getByRole("button", { name: "トピックの操作" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["編集", "削除"]);
    expect(items[0]?.getAttribute("href")).toBe("/topics/t1");
    expectInternalHrefsToResolve();

    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    expect(onDelete).toHaveBeenCalledWith(t);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the menu on a right click on the row and closes it on Escape", async () => {
    await renderWithRouter(
      <TopicRow topic={topic("t1", "x")} onDelete={vi.fn()} />,
      { path: "/topics" },
    );
    const link = screen.getByRole("link", { name: /x/ });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(link);
    const menu = screen.getByRole("menu", { name: "トピックの操作" });
    expect(document.activeElement).toBe(
      within(menu).getByRole("menuitem", { name: "編集" }),
    );
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("draws the owner's failure under the row, and none without one", async () => {
    await renderWithRouter(
      <>
        <TopicRow
          topic={topic("t1", "失敗した")}
          onDelete={vi.fn()}
          error={<p role="alert">削除できませんでした</p>}
        />
        <TopicRow topic={topic("t2", "普通")} onDelete={vi.fn()} />
      </>,
      { path: "/topics" },
    );
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toBe("削除できませんでした");
    expect(
      screen
        .getByRole("link", { name: /失敗した/ })
        .contains(alerts[0] ?? null),
    ).toBe(false);
  });

  it("draws a pending row without a link or a menu, busy, with the saving status", async () => {
    await renderWithRouter(
      <TopicRow
        topic={{ ...topic("p", "保存中の行"), pending: true }}
        onDelete={vi.fn()}
      />,
      { path: "/topics" },
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("保存中…");
    expect(screen.queryByRole("button", { name: "トピックの操作" })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(status.closest('[aria-busy="true"]')).not.toBeNull();
  });
});
