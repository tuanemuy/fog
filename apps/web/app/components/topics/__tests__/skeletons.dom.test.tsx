import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TopicDetailSkeleton } from "@/components/topics/TopicDetailSkeleton";
import { TopicsSkeleton } from "@/components/topics/TopicsSkeleton";

// A skeleton is the screen's own DOM with its text laid over — one busy
// region with one label, stand-in text hidden from assistive technology, and
// nothing to press.
function expectOneBusyRegion() {
  const region = screen.getByRole("status");
  expect(region.getAttribute("aria-busy")).toBe("true");
  expect(region.textContent).toContain("読み込み中");
  expect(within(region).queryAllByRole("button")).toHaveLength(0);
  expect(within(region).queryAllByRole("link")).toHaveLength(0);
  return region;
}

describe("TopicsSkeleton", () => {
  it("is three topic rows in the list's own shape, with the text laid over", () => {
    render(<TopicsSkeleton />);
    const region = expectOneBusyRegion();
    const items = within(region).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const stand = screen.getByText("ブランド刷新");
    expect(stand.getAttribute("aria-hidden")).toBe("true");
    expect(stand.classList.contains("text-transparent")).toBe(true);
    expect(items[0]?.contains(stand)).toBe(true);
  });
});

describe("TopicDetailSkeleton", () => {
  it("is the head, the status line and the document rows, with the text laid over", () => {
    render(<TopicDetailSkeleton />);
    const region = expectOneBusyRegion();
    // P-07's `h1` is the topic's name; until it arrives the loading label
    // carries it, and the stand-in name is no heading.
    expect(within(region).getByRole("heading", { level: 1 }).textContent).toBe(
      "読み込み中",
    );
    expect(
      within(region)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["ドキュメント"]);
    expect(screen.getByText("ブランド刷新").getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(
      screen.getByText("完了にする").closest('[aria-hidden="true"]'),
    ).not.toBeNull();
    const documents = within(region).getByRole("region", {
      name: "ドキュメント",
    });
    expect(within(documents).getAllByRole("listitem")).toHaveLength(2);
    expect(
      screen.getByText("サイト構成の方針").getAttribute("aria-hidden"),
    ).toBe("true");
  });
});
