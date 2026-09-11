import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsSkeleton } from "@/components/settings/SettingsSkeleton";

describe("SettingsSkeleton", () => {
  it("is one busy status whose only words for assistive technology are its label", () => {
    render(<SettingsSkeleton />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("読み込み中").closest("[aria-hidden]")).toBeNull();
    expect(
      screen.getByText("Claude Desktop").closest('[aria-hidden="true"]'),
    ).not.toBeNull();
    // Everything but the label is hidden, so no heading or button is exposed.
    expect(screen.queryAllByRole("heading")).toEqual([]);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("draws the panel's sections under their real labels, with disabled controls", () => {
    const { container } = render(<SettingsSkeleton />);
    const hidden = { hidden: true } as const;
    expect(
      screen
        .getAllByRole("heading", { level: 2, ...hidden })
        .map((h) => h.textContent),
    ).toEqual(["AI", "ログイン手段", "ゴミ箱", "データ", "アカウント"]);
    const buttons = screen.getAllByRole(
      "button",
      hidden,
    ) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(container.querySelector("input, a[href], form")).toBeNull();
  });
});
