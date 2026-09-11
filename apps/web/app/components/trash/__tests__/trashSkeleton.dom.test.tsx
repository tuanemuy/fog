import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrashSkeleton } from "@/components/trash/TrashSkeleton";

/** Every non-blank text node under `root`. */
function textNodesOf(root: Element): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && node.data.trim() !== "") found.push(node);
  }
  return found;
}

describe("TrashSkeleton", () => {
  it("is one busy status whose only words are its label", () => {
    render(<TrashSkeleton />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(within(status).getByText("読み込み中")).toBeTruthy();
    expect(within(status).queryAllByRole("button")).toEqual([]);
    expect(within(status).queryAllByRole("listitem")).toEqual([]);
  });

  it("draws the header and three rows from the board's parts, their text laid over and their buttons disabled, nothing animated", () => {
    const { container } = render(<TrashSkeleton />);
    expect(
      screen.getByText(
        "ここにある項目は保持期限を過ぎると完全に削除されます。",
      ),
    ).toBeTruthy();
    const rows = [...container.querySelectorAll("li")];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const buttons = [...row.querySelectorAll("button")];
      expect(buttons.map((b) => b.querySelector("svg")?.dataset.icon)).toEqual([
        "restore",
        "delete",
      ]);
      expect(buttons.every((b) => b.disabled)).toBe(true);
      const texts = textNodesOf(row);
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        expect(
          text.parentElement?.classList.contains("text-transparent"),
          `「${text.data}」 is not laid over`,
        ).toBe(true);
      }
    }
    const empty = container.querySelector("button");
    expect(empty?.closest("li")).toBeNull();
    expect(empty?.hasAttribute("disabled")).toBe(true);
    const animated = [...container.querySelectorAll("*")].filter((element) =>
      [...element.classList].some((name) => name.startsWith("animate-")),
    );
    expect(animated).toEqual([]);
  });
});
