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

  it("names itself by the title and wires both buttons", () => {
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
    expect(within(dialog).getByText(base.description)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "削除" });
    expect(confirm.classList.contains("fog-primary")).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("paints a destructive confirmation red", () => {
    render(
      <ConfirmDialog
        {...base}
        open
        danger
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "削除" })
        .classList.contains("fog-danger"),
    ).toBe(true);
  });

  it("disables both buttons and relabels while pending", () => {
    render(
      <ConfirmDialog
        {...base}
        open
        pending
        cancelLabel="やめる"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const confirm = screen.getByRole("button", { name: "削除中…" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "やめる" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
