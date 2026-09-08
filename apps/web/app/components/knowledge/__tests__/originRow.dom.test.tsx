import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { OriginList, OriginRow } from "@/components/knowledge/OriginRow";
import { formatDateTime } from "@/presentation/time";

const postedAt = new Date("2026-01-01T14:05:00Z");

describe("OriginRow", () => {
  it("links a live memo to its timeline position", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <OriginRow
        memo={{ memoId: "m1", snippet: "抜粋", postedAt, deleted: false }}
      />,
      { path: "/topics/$topicId" },
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toContain("memo=m1");
    expect(link.textContent).toContain(formatDateTime(postedAt));
    expect(link.textContent).toContain("抜粋");
    expectInternalHrefsToResolve();
  });

  it("renders a deleted memo as a non-navigable row", async () => {
    await renderWithRouter(
      <OriginRow
        memo={{ memoId: "m1", snippet: "抜粋", postedAt, deleted: true }}
      />,
      { path: "/topics/$topicId" },
    );
    expect(screen.queryByRole("link")).toBeNull();
    const row = document.querySelector(".fog-origin-row");
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(row?.textContent).toContain("削除されたメモ");
    expect(row?.textContent).not.toContain("抜粋");
  });
});

describe("OriginList", () => {
  it("renders nothing for no memos and a labelled section otherwise", async () => {
    const { container } = await renderWithRouter(
      <OriginList memos={[]} label="関連メモ" />,
      {
        path: "/topics/$topicId",
      },
    );
    expect(container.querySelector("section")).toBeNull();
    await renderWithRouter(
      <OriginList
        memos={[{ memoId: "m1", snippet: "a", postedAt, deleted: false }]}
        label="元になったメモ"
      />,
      { path: "/topics/$topicId" },
    );
    const section = screen.getByRole("region", { name: "元になったメモ" });
    expect(section.querySelector("h3")?.textContent).toBe("元になったメモ");
    expect(section.querySelectorAll(".fog-origin-row")).toHaveLength(1);
  });
});
