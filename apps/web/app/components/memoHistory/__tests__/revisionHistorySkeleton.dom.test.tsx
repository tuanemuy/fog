import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RevisionHistorySkeleton } from "@/components/memoHistory/RevisionHistorySkeleton";

// The stand-in text is `Sk`'s: hidden from assistive technology, the glyphs
// transparent. What a reader gets is the status and its one label.
function standIns(container: HTMLElement) {
  return [...container.querySelectorAll('[aria-hidden="true"]')].map(
    (el) => el.textContent,
  );
}

describe("RevisionHistorySkeleton", () => {
  it("draws the memo history's list as one busy status, the row text laid over", () => {
    const { container } = render(<RevisionHistorySkeleton subject="memo" />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(within(status).getByText("読み込み中")).toBeTruthy();
    expect(
      within(status).getByRole("heading", { level: 2, name: "履歴" }),
    ).toBeTruthy();
    const items = within(status).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(within(item).queryByRole("button")).toBeNull();
      const hidden = item.querySelectorAll('[aria-hidden="true"]');
      expect(hidden).toHaveLength(2);
      expect(item.textContent).toBe(
        [...hidden].map((el) => el.textContent).join(""),
      );
    }
    expect(standIns(container)).not.toContain("ドキュメントのタイトル");
    expect(standIns(container)).toContain("あなた");
  });

  it("opens the document history with its title line before the list", () => {
    const { container } = render(
      <RevisionHistorySkeleton subject="document" />,
    );
    const status = screen.getByRole("status");
    const title = within(status).getByText("ドキュメントのタイトル");
    expect(title.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const list = within(status).getByRole("list");
    expect(
      title.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(standIns(container)).toContain("あなた · 手動編集");
  });
});
