import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionLabel } from "@/components/ui/SectionLabel";

describe("EmptyState", () => {
  it("is one sentence and nothing else when there is nowhere to go", () => {
    const { container } = render(<EmptyState message="ゴミ箱は空です" />);
    const sentence = screen.getByText("ゴミ箱は空です");
    expect(sentence.tagName).toBe("P");
    expect(container.textContent).toBe("ゴミ箱は空です");
    expect(sentence.nextElementSibling).toBeNull();
  });

  it("puts its one control under the sentence", () => {
    render(
      <EmptyState
        message="読み込めませんでした"
        action={<Button variant="fill">再試行</Button>}
      />,
    );
    const sentence = screen.getByText("読み込めませんでした");
    const retry = screen.getByRole("button", { name: "再試行" });
    expect(sentence.nextElementSibling?.contains(retry)).toBe(true);
    expect(sentence.classList.contains("next-sibling:mt-lg")).toBe(true);
  });
});

describe("SectionLabel", () => {
  it("opens a section as a heading at the level asked", () => {
    render(
      <>
        <SectionLabel>出典</SectionLabel>
        <SectionLabel level={3}>元になったメモ</SectionLabel>
      </>,
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "出典" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 3, name: "元になったメモ" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 2, name: "元になったメモ" }),
    ).toBeNull();
  });

  it("names the list that follows it", () => {
    render(
      <>
        <SectionLabel id="origin-label">出典</SectionLabel>
        <ul aria-labelledby="origin-label">
          <li>a</li>
        </ul>
      </>,
    );
    const label = screen.getByRole("heading", { name: "出典" });
    expect(screen.getByRole("list", { name: "出典" })).toBe(
      label.nextElementSibling,
    );
    expect(label.classList.contains("next-sibling:mt-md")).toBe(true);
  });
});
