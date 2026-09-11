import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/ui/Markdown";

const DASH = "before:content-['–']";

const draw = (body: string, variant: "memo" | "document" = "memo") =>
  render(<Markdown body={body} variant={variant} />);

describe("Markdown", () => {
  it("marks unordered items with the dash and leaves ordered items numbered", () => {
    draw("- 論点\n- 範囲\n\n1. 一つ目\n   - 補足\n2. 二つ目");
    const dashed = screen.getByText("論点");
    expect(dashed.tagName).toBe("LI");
    expect(dashed.classList.contains(DASH)).toBe(true);
    const numbered = screen.getByText("一つ目");
    expect(numbered.tagName).toBe("LI");
    expect(numbered.classList.contains(DASH)).toBe(false);
    expect(numbered.parentElement?.classList.contains("list-decimal")).toBe(
      true,
    );
    expect(screen.getByText("補足").classList.contains(DASH)).toBe(true);
  });

  it("draws no dash in front of a task list checkbox", () => {
    draw("- [ ] 見積もり\n- 通常の項目");
    const task = screen.getByRole("checkbox").closest("li");
    expect(screen.getByText("通常の項目").classList.contains(DASH)).toBe(true);
    expect(task?.classList.contains(DASH)).toBe(false);
  });

  it("sets a document looser than a memo and gives its headings their own step", () => {
    const { container: memo } = draw("## 構成\n\n本文", "memo");
    const { container: doc } = draw("## 決めたこと\n\n本文", "document");
    expect(memo.firstElementChild?.classList.contains("leading-normal")).toBe(
      true,
    );
    expect(doc.firstElementChild?.classList.contains("leading-loose")).toBe(
      true,
    );
    const docHeading = screen.getByRole("heading", { name: "決めたこと" });
    const memoHeading = screen.getByRole("heading", { name: "構成" });
    expect(docHeading.classList.contains("text-lg")).toBe(true);
    expect(docHeading.classList.contains("mb-[0.9em]")).toBe(true);
    expect(memoHeading.classList.contains("text-lg")).toBe(false);
    expect(memoHeading.classList.contains("mb-[0.9em]")).toBe(false);
  });

  it("keeps the inline code background off a code block", () => {
    const { container } = draw("`inline`\n\n```\nconst a = 1;\n```");
    const inline = screen.getByText("inline");
    expect(inline.tagName).toBe("CODE");
    expect(inline.classList.contains("bg-neutral-100")).toBe(true);
    const block = container.querySelector("pre > code");
    expect(block?.textContent).toBe("const a = 1;\n");
    expect(block?.classList.contains("bg-neutral-100")).toBe(false);
  });

  it("leaves raw HTML as visible text and never inserts it", () => {
    const { container } = draw(
      'before <script>alert(1)</script> <b onclick="x()">bold</b>',
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe(
      'before <script>alert(1)</script> <b onclick="x()">bold</b>',
    );
  });

  it("draws links and puts a wide table in its own scroll box", () => {
    draw("[fog](https://example.com)\n\n| a | b |\n| - | - |\n| 1 | 2 |");
    expect(screen.getByRole("link", { name: "fog" }).getAttribute("href")).toBe(
      "https://example.com",
    );
    const table = screen.getByRole("table");
    expect(table.parentElement?.classList.contains("overflow-x-auto")).toBe(
      true,
    );
  });
});
