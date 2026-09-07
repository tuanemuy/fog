import type { TimelineItemView } from "@repo/core/application/memo/view";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoEntry } from "@/components/timeline/MemoEntry";

function memo(body: string, postedAt: Date): TimelineItemView {
  return {
    id: "m1",
    body,
    postedAt,
    updatedAt: postedAt,
    latestRevisionNumber: 1,
    version: 1,
    sourceDocuments: [],
  };
}

describe("MemoEntry", () => {
  it("stamps the ISO instant and the Asia/Tokyo wall-clock time", () => {
    // 14:05 UTC is 23:05 in Tokyo.
    const postedAt = new Date("2026-01-01T14:05:00Z");
    const { container } = render(<MemoEntry memo={memo("body", postedAt)} />);
    const time = container.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-01-01T14:05:00.000Z");
    expect(time?.textContent).toBe("23:05");
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      container.querySelector("article")?.getAttribute("aria-busy"),
    ).toBeNull();
  });

  it("renders a Markdown list as list items", () => {
    render(<MemoEntry memo={memo("- a\n- b", new Date(0))} />);
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["a", "b"]);
  });

  it("never inserts a script element from the body", () => {
    const { container } = render(
      <MemoEntry
        memo={memo(
          "before <script>alert(1)</script> after\n\n<script>alert(2)</script>",
          new Date(0),
        )}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("<script");
    // `skipHtml` drops the tags and keeps inline text; a block-level script
    // is dropped whole.
    expect(container.querySelector(".fog-markdown")?.textContent?.trim()).toBe(
      "before alert(1) after",
    );
  });

  it("marks a pending entry busy with a saving status", () => {
    const { container } = render(
      <MemoEntry memo={{ ...memo("x", new Date(0)), pending: true }} />,
    );
    expect(container.querySelector("article")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.getByRole("status").textContent).toBe("保存中…");
  });
});
