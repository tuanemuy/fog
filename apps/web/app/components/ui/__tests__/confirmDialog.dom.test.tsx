import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

const base = {
  title: "メモを削除しますか？",
  description: "ゴミ箱に移動します。",
  confirmLabel: "削除",
};

describe("ConfirmDialog", () => {
  it("renders nothing while closed", () => {
    const { container } = render(
      <ConfirmDialog
        {...base}
        open={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names itself by the title and stacks confirm above cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        {...base}
        open
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: base.title });
    const title = within(dialog).getByRole("heading", { name: base.title });
    const sentence = within(dialog).getByText(base.description);
    expect(title.nextElementSibling).toBe(sentence);
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "削除",
      "キャンセル",
    ]);
    fireEvent.click(within(dialog).getByRole("button", { name: "削除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("confirms with the primary fill unless the action is destructive, which gets the red outline and ring", () => {
    const { unmount } = render(
      <ConfirmDialog
        {...base}
        confirmLabel="戻す"
        open
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const primary = screen.getByRole("button", { name: "戻す" });
    expect(primary.classList.contains("bg-primary-dark")).toBe(true);
    expect(primary.classList.contains("text-error")).toBe(false);
    expect(primary.classList.contains("focus-visible:outline-focus")).toBe(
      true,
    );
    unmount();

    render(
      <ConfirmDialog
        {...base}
        open
        danger
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const danger = screen.getByRole("button", { name: "削除" });
    expect(danger.classList.contains("text-error")).toBe(true);
    expect(danger.classList.contains("bg-primary-dark")).toBe(false);
    expect(
      danger.classList.contains("focus-visible:outline-focus-danger"),
    ).toBe(true);
    const cancel = screen.getByRole("button", { name: "キャンセル" });
    expect(cancel.classList.contains("text-neutral-600")).toBe(true);
    expect(
      cancel.classList.contains("focus-visible:outline-focus-danger"),
    ).toBe(false);
  });

  it("cancels on a click on the backdrop, not on one inside the box", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog {...base} open onConfirm={() => {}} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByText(base.description));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons and relabels while pending", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        {...base}
        open
        pending
        cancelLabel="やめる"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    const confirm = screen.getByRole("button", { name: "削除中…" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "やめる" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
