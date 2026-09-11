import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import {
  PopoverMenu,
  PopoverMenuItem,
  PopoverMenuLink,
} from "@/components/ui/PopoverMenu";

function MemoMenu({
  onEdit = () => {},
  onDelete = () => {},
}: {
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <PopoverMenu label="メモの操作">
      <PopoverMenuItem icon="edit" onSelect={onEdit}>
        編集
      </PopoverMenuItem>
      <PopoverMenuItem icon="delete" tone="danger" onSelect={onDelete}>
        削除
      </PopoverMenuItem>
    </PopoverMenu>
  );
}

const trigger = () => screen.getByRole("button", { name: "メモの操作" });
const open = () => fireEvent.click(trigger());

describe("PopoverMenu", () => {
  it("opens from the three-dot trigger, named by it, with focus on the first item", () => {
    render(<MemoMenu />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().querySelector("svg")?.getAttribute("data-icon")).toBe(
      "more",
    );
    expect(screen.queryByRole("menu")).toBeNull();

    open();
    const menu = screen.getByRole("menu", { name: "メモの操作" });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(menu.id);
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["編集", "削除"]);
    expect(document.activeElement).toBe(items[0]);
    expect(
      items.map((item) => item.querySelector("svg")?.getAttribute("data-icon")),
    ).toEqual(["edit", "delete"]);
  });

  it("paints the destructive item red and the ordinary one neutral", () => {
    render(<MemoMenu />);
    open();
    const edit = screen.getByRole("menuitem", { name: "編集" });
    const remove = screen.getByRole("menuitem", { name: "削除" });
    expect(remove.classList.contains("text-error")).toBe(true);
    expect(edit.classList.contains("text-error")).toBe(false);
    expect(edit.classList.contains("text-neutral-900")).toBe(true);
  });

  it("runs the chosen action once focus is back on the trigger, and closes", () => {
    let focusedOnSelect: Element | null = null;
    const onDelete = vi.fn(() => {
      focusedOnSelect = document.activeElement;
    });
    render(<MemoMenu onDelete={onDelete} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(focusedOnSelect).toBe(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("walks the items with the arrow keys, Home and End, wrapping at both ends", () => {
    render(<MemoMenu />);
    open();
    const menu = screen.getByRole("menu");
    const [edit, remove] = within(menu).getAllByRole("menuitem");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(remove);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(edit);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(remove);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(edit);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(remove);
  });

  it("closes on Escape with focus back on the trigger, and on a press outside where focus is", () => {
    render(
      <>
        <MemoMenu />
        <p>本文</p>
      </>,
    );
    open();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());

    open();
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "編集" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("本文"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("follows the owner's open state when it is controlled", () => {
    const onOpenChange = vi.fn();
    function Owner() {
      const [menuOpen, setMenuOpen] = useState(false);
      return (
        <>
          <button type="button" onContextMenu={() => setMenuOpen(true)}>
            行
          </button>
          <PopoverMenu
            label="トピックの操作"
            open={menuOpen}
            onOpenChange={(next) => {
              onOpenChange(next);
              setMenuOpen(next);
            }}
          >
            <PopoverMenuItem icon="edit" onSelect={() => {}}>
              編集
            </PopoverMenuItem>
          </PopoverMenu>
        </>
      );
    }
    render(<Owner />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "行" }));
    expect(screen.getByRole("menu", { name: "トピックの操作" })).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("PopoverMenuLink", () => {
  it("is a menu item that leads to its route and closes the menu when followed", async () => {
    const { expectInternalHrefsToResolve, router } = await renderWithRouter(
      <PopoverMenu label="メモの操作">
        <PopoverMenuLink
          icon="history"
          to="/memos/$memoId/history"
          params={{ memoId: "m1" }}
        >
          履歴
        </PopoverMenuLink>
      </PopoverMenu>,
    );
    open();
    const history = screen.getByRole("menuitem", { name: "履歴" });
    expect(history.tagName).toBe("A");
    expect(history.getAttribute("href")).toBe("/memos/m1/history");
    expect(expectInternalHrefsToResolve()).toEqual(["/memos/m1/history"]);
    fireEvent.click(history);
    expect(screen.queryByRole("menu")).toBeNull();
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/memos/m1/history"),
    );
  });
});
