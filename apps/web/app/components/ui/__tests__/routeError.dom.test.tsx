import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { buttonClassName } from "@/components/ui/Button/styles";
import { NotFound } from "@/components/ui/NotFound";
import { PageHeadingOwnerProvider } from "@/components/ui/PageHeading";
import { RouteError } from "@/components/ui/RouteError";
import { RoutePendingFallback } from "@/components/ui/RoutePendingFallback";

describe("RouteError", () => {
  it("is one alert: the sentence and 再試行 as the empty state's one filled control", async () => {
    await renderWithRouter(<RouteError />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("読み込めませんでした再試行");
    const sentence = within(alert).getByText("読み込めませんでした");
    expect(sentence.tagName).toBe("P");
    const retry = within(alert).getByRole("button", { name: "再試行" });
    expect(retry.className).toBe(buttonClassName("fill"));
    expect(sentence.nextElementSibling?.contains(retry)).toBe(true);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("reruns the loaders on 再試行, and cannot be pressed again until they settle", async () => {
    const { router } = await renderWithRouter(<RouteError />);
    let settle = () => {};
    const invalidate = vi
      .spyOn(router, "invalidate")
      .mockImplementation(
        () => new Promise<void>((resolve) => (settle = resolve)),
      );
    const retry = screen.getByRole("button", { name: "再試行" });
    expect(retry.hasAttribute("disabled")).toBe(false);

    fireEvent.click(retry);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(retry.hasAttribute("disabled")).toBe(true);
    fireEvent.click(retry);
    expect(invalidate).toHaveBeenCalledTimes(1);
    await act(async () => settle());
    expect(retry.hasAttribute("disabled")).toBe(false);
  });

  it("makes its sentence the page's h1 where the screen owns the heading", async () => {
    await renderWithRouter(
      <PageHeadingOwnerProvider owner="screen">
        <RouteError />
      </PageHeadingOwnerProvider>,
    );
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("読み込めませんでした");
    expect(screen.getByRole("alert").contains(heading)).toBe(true);
  });
});

describe("NotFound", () => {
  it("is the sentence and the way back to the timeline, and no alert", async () => {
    const { container, expectInternalHrefsToResolve } = await renderWithRouter(
      <NotFound />,
    );
    const sentence = screen.getByText("ページが見つかりません");
    expect(sentence.tagName).toBe("P");
    const back = screen.getByRole("link", { name: "タイムラインへ" });
    expect(back.getAttribute("href")).toBe("/");
    expect(back.className).toBe(buttonClassName("fill"));
    expect(sentence.nextElementSibling?.contains(back)).toBe(true);
    expect(container.textContent).toBe("ページが見つかりませんタイムラインへ");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(expectInternalHrefsToResolve()).toEqual(["/"]);
  });

  it("makes its sentence the page's h1 where the screen owns the heading", async () => {
    await renderWithRouter(
      <PageHeadingOwnerProvider owner="screen">
        <NotFound />
      </PageHeadingOwnerProvider>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "ページが見つかりません",
    );
  });
});

describe("RoutePendingFallback", () => {
  it("is one busy status whose only words are the loading label", () => {
    render(<RoutePendingFallback />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(region.getAttribute("aria-live")).toBe("polite");
    const label = within(region).getByText("読み込み中");
    expect(label.classList.contains("sr-only")).toBe(true);
    const shown = [...region.querySelectorAll("p")];
    expect(shown.length).toBeGreaterThan(0);
    for (const line of shown) {
      const [stand, ...rest] = [...line.children];
      expect(rest).toEqual([]);
      expect(stand?.textContent).toBe(line.textContent);
      expect(stand?.getAttribute("aria-hidden")).toBe("true");
      expect(stand?.classList.contains("text-transparent")).toBe(true);
    }
  });

  it("lays text over real lines and does not animate", () => {
    const { container } = render(<RoutePendingFallback />);
    const all = [...container.querySelectorAll("*")];
    expect(
      all.filter((element) =>
        [...element.classList].some((name) => name.startsWith("animate-")),
      ),
    ).toEqual([]);
    const hidden = all.filter(
      (element) => element.getAttribute("aria-hidden") === "true",
    );
    expect(hidden.length).toBeGreaterThan(0);
    for (const element of hidden) {
      expect(element.textContent).not.toBe("");
    }
  });
});
