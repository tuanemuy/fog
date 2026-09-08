import { createRouter } from "@tanstack/react-router";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { AppShell, NAV_ITEMS, titleFor } from "@/components/layout/AppShell";
import { routeTree } from "@/routeTree.gen";

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

/** `spec/pages/index.md`: the five destinations of the common layout. */
const SPEC_DESTINATIONS = [
  "/",
  "/topics",
  "/search",
  "/trash",
  "/settings",
] as const;

/** Full paths the production route tree actually serves. */
function productionPaths(): string[] {
  return Object.keys(createRouter({ routeTree }).routesByPath);
}

function mainNav() {
  return screen.getByRole("navigation", { name: "メインナビゲーション" });
}

describe("NAV_ITEMS", () => {
  it("lists only destinations the production route tree serves", () => {
    const paths = productionPaths();
    for (const item of NAV_ITEMS) {
      expect(paths, `${item.to} is not a route`).toContain(item.to);
    }
  });

  it("serves the memo history route without listing it in the nav", () => {
    expect(productionPaths()).toContain("/memos/$memoId/history");
    expect(
      NAV_ITEMS.some((item) => (item.to as string).startsWith("/memos")),
    ).toBe(false);
  });

  it("carries each spec destination exactly when its route exists", () => {
    const paths = productionPaths();
    const navTargets = NAV_ITEMS.map((item) => item.to as string);
    for (const destination of SPEC_DESTINATIONS) {
      expect(
        navTargets.includes(destination),
        `${destination}: nav=${navTargets.includes(destination)} route=${paths.includes(destination)}`,
      ).toBe(paths.includes(destination));
    }
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "タイムライン",
      "トピック",
      "設定",
    ]);
  });
});

describe("titleFor", () => {
  it("names the timeline, the memo history and the settings screens", () => {
    expect(titleFor("/")).toBe("タイムライン");
    expect(titleFor("/memos/abc/history")).toBe("メモ履歴");
    expect(titleFor("/settings")).toBe("設定");
  });

  it("names the knowledge screens", () => {
    expect(titleFor("/topics")).toBe("トピック");
    expect(titleFor("/topics/abc")).toBe("トピック詳細");
    expect(titleFor("/topics/abc/documents/new")).toBe("ドキュメント作成");
    expect(titleFor("/documents/abc")).toBe("ドキュメント");
    expect(titleFor("/documents/abc/edit")).toBe("ドキュメント編集");
    expect(titleFor("/documents/abc/history")).toBe("ドキュメント履歴");
  });

  it("falls back to the product name elsewhere", () => {
    expect(titleFor("/nowhere")).toBe("fog");
  });
});

describe("AppShell", () => {
  it("draws one live link per NAV_ITEM, each resolving to a route", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <AppShell>
        <p>child</p>
      </AppShell>,
    );
    const links = within(mainNav()).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(
      NAV_ITEMS.map((item) => item.label),
    );
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      NAV_ITEMS.map((item) => item.to),
    );
    expectInternalHrefsToResolve();
    expect(screen.getByText("child")).toBeTruthy();
  });

  it("marks the timeline item current on /", async () => {
    await renderWithRouter(<AppShell>x</AppShell>, { path: "/" });
    const nav = within(mainNav());
    expect(
      nav
        .getByRole("link", { name: "タイムライン" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      nav.getByRole("link", { name: "設定" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "タイムライン",
    );
  });

  it("marks the settings item current on /settings", async () => {
    await renderWithRouter(<AppShell>x</AppShell>, { path: "/settings" });
    const nav = within(mainNav());
    expect(
      nav.getByRole("link", { name: "設定" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      nav
        .getByRole("link", { name: "タイムライン" })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("設定");
  });

  it("marks the topics item current on /topics", async () => {
    await renderWithRouter(<AppShell>x</AppShell>, { path: "/topics" });
    const nav = within(mainNav());
    expect(
      nav.getByRole("link", { name: "トピック" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      nav
        .getByRole("link", { name: "タイムライン" })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "トピック",
    );
    expect(NAV_ITEMS[1]?.match("/documents/x")).toBe(true);
    expect(NAV_ITEMS[1]?.match("/topics/x")).toBe(true);
  });

  it("offers a dialog-backed mobile menu and a skip link to #main", async () => {
    await renderWithRouter(<AppShell>x</AppShell>);
    expect(
      screen
        .getByRole("button", { name: "メニューを開く" })
        .getAttribute("aria-haspopup"),
    ).toBe("dialog");
    expect(
      screen.getByRole("link", { name: "本文へ移動" }).getAttribute("href"),
    ).toBe("#main");
    expect(screen.getByRole("main").id).toBe("main");
  });
});
