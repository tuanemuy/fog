import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { OriginList, OriginRow } from "@/components/knowledge/OriginRow";
import { formatDateTime } from "@/presentation/time";

const postedAt = new Date("2026-01-01T14:05:00Z");

describe("OriginRow", () => {
  it("links a live memo to its timeline position, ending in the jump mark", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <OriginRow
        memo={{ memoId: "m1", snippet: "抜粋", postedAt, deleted: false }}
      />,
      { path: "/topics/$topicId" },
    );
    const link = screen.getByRole("link", { name: "タイムラインで表示: 抜粋" });
    expect(link.getAttribute("href")).toContain("memo=m1");
    expect(link.textContent).toBe(`${formatDateTime(postedAt)}抜粋`);
    expect(link.querySelector("svg")?.getAttribute("data-icon")).toBe("jump");
    expectInternalHrefsToResolve();
  });

  it("renders a deleted memo as a grayed row that does not navigate", async () => {
    const { container } = await renderWithRouter(
      <OriginRow
        memo={{ memoId: "m1", snippet: "抜粋", postedAt, deleted: true }}
      />,
      { path: "/topics/$topicId" },
    );
    expect(screen.queryByRole("link")).toBeNull();
    const row = screen.getByText("削除済みのメモ").closest("[aria-disabled]");
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(row?.textContent).toBe(`${formatDateTime(postedAt)}削除済みのメモ`);
    expect(container.textContent).not.toContain("抜粋");
    const mark = row?.querySelector("svg");
    expect(mark?.getAttribute("data-icon")).toBe("jump");
    expect(mark?.parentElement?.classList.contains("text-neutral-300")).toBe(
      true,
    );
  });
});

describe("OriginList", () => {
  it("renders nothing for no memos", async () => {
    const { container } = await renderWithRouter(
      <OriginList memos={[]} label="関連メモ" />,
      { path: "/topics/$topicId" },
    );
    expect(container.querySelector("section")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("puts the memos under their label, one list item each, at the heading level asked", async () => {
    await renderWithRouter(
      <>
        <OriginList
          memos={[
            { memoId: "m1", snippet: "a", postedAt, deleted: false },
            { memoId: "m2", snippet: "b", postedAt, deleted: true },
          ]}
          label="関連メモ"
        />
        <OriginList
          memos={[{ memoId: "m3", snippet: "c", postedAt, deleted: false }]}
          label="元になったメモ"
          level={2}
        />
      </>,
      { path: "/topics/$topicId" },
    );
    const related = screen.getByRole("region", { name: "関連メモ" });
    expect(within(related).getByRole("heading", { level: 3 }).textContent).toBe(
      "関連メモ",
    );
    expect(within(related).getAllByRole("listitem")).toHaveLength(2);
    expect(within(related).getAllByRole("link")).toHaveLength(1);
    const origin = screen.getByRole("region", { name: "元になったメモ" });
    expect(within(origin).getByRole("heading", { level: 2 }).textContent).toBe(
      "元になったメモ",
    );
    expect(within(origin).queryByRole("heading", { level: 3 })).toBeNull();
  });
});
