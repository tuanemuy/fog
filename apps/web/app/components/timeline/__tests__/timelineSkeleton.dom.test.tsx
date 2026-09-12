import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimelineSkeleton } from "@/components/timeline/TimelineSkeleton";

const standIns = (root: Element) =>
  [...root.querySelectorAll('[aria-hidden="true"]')].filter(
    (element) => element.textContent !== "",
  );

describe("TimelineSkeleton", () => {
  it("is one busy status whose only words are its label", () => {
    render(<TimelineSkeleton />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(region.getAttribute("aria-live")).toBe("polite");
    const heard = region.cloneNode(true) as HTMLElement;
    for (const hidden of heard.querySelectorAll('[aria-hidden="true"]')) {
      hidden.remove();
    }
    expect(heard.textContent).toBe("読み込み中");
    expect(standIns(region).length).toBeGreaterThan(0);
  });

  it("lays the stand-in text over a day heading and three entries, with no heading of its own", () => {
    render(<TimelineSkeleton />);
    const region = screen.getByRole("status");
    expect(screen.queryAllByRole("heading")).toEqual([]);
    expect(standIns(region).map((element) => element.textContent)).toEqual([
      "2026年7月22日(水)",
      "10:30",
      expect.stringContaining("今日は仕事が捗った"),
      "12:30",
      expect.stringContaining("ワイヤーフレーム"),
      "13:30",
      expect.stringContaining("午後の打ち合わせ"),
    ]);
    const bodies = [...region.querySelectorAll("p")];
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(standIns(body)).toHaveLength(1);
    }
  });
});
