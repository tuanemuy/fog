import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { BrandLockup } from "@/components/layout/BrandLockup";
import {
  PageHeader,
  type PageHeaderDeclaration,
} from "@/components/layout/PageHeader";

const NAV = { sheetId: "nav-sheet", open: false, onOpen: () => {} } as const;

const header = (declaration: PageHeaderDeclaration) => (
  <PageHeader declaration={declaration} actionsRef={() => {}} nav={NAV} />
);

const TOPIC: PageHeaderDeclaration = {
  kind: "back",
  entity: "topic",
  back: "/topics",
  h1: "header",
};

const brandPoint = () =>
  screen.getByRole("banner").querySelector("[data-brand-point]");

describe("BrandLockup", () => {
  it("draws logo.md's lockup at its UI size, with the one orange point inside the icon", () => {
    render(<BrandLockup />);
    const svg = screen.getByRole("img", { name: "fog" });
    expect(svg.getAttribute("viewBox")).toBe("0 0 64.7 26");
    expect(svg.getAttribute("width")).toBe("64.7");
    expect(svg.getAttribute("height")).toBe("26");
    // lockup.svg's ink, on the SVG itself so a link around it cannot recolor it.
    expect(svg.classList.contains("text-neutral-900")).toBe(true);
    const [icon, wordmark] = [...svg.children];
    const circles = [...svg.querySelectorAll("circle")];
    expect(circles).toHaveLength(1);
    expect(icon?.contains(circles[0] ?? null)).toBe(true);
    expect(circles[0]?.classList.contains("fill-accent")).toBe(true);
    expect(wordmark?.querySelectorAll("path")).toHaveLength(3);
    expect(wordmark?.getAttribute("fill")).toBe("currentColor");
  });
});

describe("PageHeader — top", () => {
  it("shows the lockup below lg and keeps the title as a hidden h1", async () => {
    await renderWithRouter(header({ kind: "top", title: "ゴミ箱" }));
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("ゴミ箱");
    expect(h1.classList.contains("sr-only")).toBe(true);
    const lockup = screen.getByRole("img", { name: "fog" });
    expect(lockup.parentElement?.classList.contains("lg:hidden")).toBe(true);
    expect(screen.queryByRole("link", { name: "戻る" })).toBeNull();
    expect(brandPoint()).toBeNull();
  });
});

describe("PageHeader — back", () => {
  it("shows the back button and the English title in the brand face with the point", async () => {
    await renderWithRouter(header(TOPIC), { path: "/topics/$topicId" });
    expect(
      screen.getByRole("link", { name: "戻る" }).querySelector("svg")?.dataset
        .icon,
    ).toBe("back");
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("topic");
    expect(h1.getAttribute("lang")).toBe("en");
    expect(h1.classList.contains("font-brand")).toBe(true);
    expect(h1.classList.contains("sr-only")).toBe(false);
    const point = brandPoint();
    expect(point?.classList.contains("bg-accent")).toBe(true);
    expect(point?.classList.contains("lg:hidden")).toBe(true);
    expect(screen.queryByRole("img", { name: "fog" })).toBeNull();
  });

  it("draws the English title as a plain label when the sheet holds the page's h1", async () => {
    await renderWithRouter(
      header({
        kind: "back",
        entity: "document",
        back: "/topics",
        h1: "sheet",
      }),
      { path: "/documents/$documentId" },
    );
    const label = screen.getByText("document");
    expect(label.getAttribute("lang")).toBe("en");
    expect(label.classList.contains("font-brand")).toBe(true);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("leads to the declared place, filled with the current route's params", async () => {
    const { router, expectInternalHrefsToResolve } = await renderWithRouter(
      header({
        kind: "back",
        entity: "document",
        back: "/documents/$documentId",
        h1: "header",
      }),
    );
    await router.navigate({
      to: "/documents/$documentId/edit",
      params: { documentId: "d1" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "戻る" }).getAttribute("href"),
      ).toBe("/documents/d1"),
    );
    expectInternalHrefsToResolve();
  });

  it("goes to the declared place when opened without in-app history", async () => {
    const { router } = await renderWithRouter(header(TOPIC), {
      path: "/topics/$topicId",
    });
    expect(router.history.canGoBack()).toBe(false);
    fireEvent.click(screen.getByRole("link", { name: "戻る" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/topics"));
  });

  it("goes back through the in-app history when there is one", async () => {
    const { router } = await renderWithRouter(header(TOPIC), { path: "/" });
    await router.navigate({
      to: "/topics/$topicId",
      params: { topicId: "t1" },
    });
    expect(router.history.canGoBack()).toBe(true);
    const back = vi.spyOn(router.history, "back");
    fireEvent.click(screen.getByRole("link", { name: "戻る" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(back).toHaveBeenCalledTimes(1);
  });
});
