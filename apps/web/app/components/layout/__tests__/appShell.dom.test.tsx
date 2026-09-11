import {
  type AnyRoute,
  createRouter,
  type StaticDataRouteOption,
} from "@tanstack/react-router";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  renderWithRouter,
  STUB_PATHS,
  type StubStaticData,
} from "@/components/__tests__/renderWithRouter";
import { AppShell } from "@/components/layout/AppShell";
import { NAV_ITEMS } from "@/components/layout/navigation";
import type { HeaderEntity } from "@/components/layout/PageHeader";
import {
  BottomDock,
  HeaderActions,
  useSheetScrollContainer,
} from "@/components/layout/ShellSlots";
import { useToast } from "@/components/ui/Toast";
import { getRouter } from "@/router";
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

/** logo.md: the noun each page with a back button names. */
const BACK_ENTITIES: Readonly<Record<string, HeaderEntity>> = {
  "/topics/$topicId": "topic",
  "/memos/$memoId/history": "memo",
  "/documents/$documentId": "document",
  "/documents/$documentId/edit": "document",
  "/documents/$documentId/history": "document",
  "/topics/$topicId/documents/new": "document",
};

const productionRouter = () => createRouter({ routeTree });

/** Full paths the production route tree actually serves. */
function productionPaths(): string[] {
  return Object.keys(productionRouter().routesByPath);
}

function productionRoute(path: string): AnyRoute | undefined {
  return new Map<string, AnyRoute>(
    Object.entries(productionRouter().routesByPath),
  ).get(path);
}

/** The screens drawn inside the shell: every route under `_app`. */
function screensInTheShell(): AnyRoute[] {
  const routes: AnyRoute[] = Object.values(productionRouter().routesById);
  return routes.filter((route) => route.id.startsWith("/_app/"));
}

/** The production routes' header declarations, handed to the stub tree. */
const PRODUCTION_STATIC_DATA: StubStaticData = Object.fromEntries(
  STUB_PATHS.map((path) => [
    path,
    (productionRoute(path)?.options.staticData ?? {}) as StaticDataRouteOption,
  ]),
);

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
      "検索",
      "ゴミ箱",
      "設定",
    ]);
    expect(NAV_ITEMS[1]?.match("/documents/x")).toBe(true);
    expect(NAV_ITEMS[1]?.match("/topics/x")).toBe(true);
  });
});

describe("header declarations", () => {
  it("are made by every screen the shell draws", () => {
    const screens = screensInTheShell();
    expect(screens.length).toBeGreaterThan(0);
    for (const route of screens) {
      expect(route.options.staticData?.header, route.id).toBeDefined();
    }
  });

  it("give the five destinations the lockup, titled as the nav names them", () => {
    for (const item of NAV_ITEMS) {
      expect(productionRoute(item.to)?.options.staticData?.header).toEqual({
        kind: "top",
        title: item.label,
      });
    }
  });

  it("name what a page with a back button is about, and lead back to a served route", () => {
    const backPages = screensInTheShell().filter(
      (route) => route.options.staticData?.header?.kind === "back",
    );
    expect(backPages.map((route) => route.fullPath).sort()).toEqual(
      Object.keys(BACK_ENTITIES).sort(),
    );
    for (const route of backPages) {
      const header = route.options.staticData?.header;
      if (header?.kind !== "back") throw new Error(route.id);
      expect(header.entity, route.fullPath).toBe(BACK_ENTITIES[route.fullPath]);
      expect(productionPaths(), route.fullPath).toContain(header.back);
    }
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

  it("puts the lockup, not a text wordmark, on the sidebar's link home", async () => {
    await renderWithRouter(<AppShell>x</AppShell>);
    const home = screen.getByRole("link", { name: "fog タイムライン" });
    expect(home.getAttribute("href")).toBe("/");
    expect(within(home).getByRole("img", { name: "fog" }).tagName).toBe("svg");
    expect(home.textContent).toBe("");
    expect(home.closest("aside")?.classList.contains("lg:flex")).toBe(true);
  });

  it("marks the timeline item current on / and titles the page from its declaration", async () => {
    await renderWithRouter(<AppShell>x</AppShell>, {
      path: "/",
      staticData: PRODUCTION_STATIC_DATA,
    });
    const nav = within(mainNav());
    expect(
      nav
        .getByRole("link", { name: "タイムライン" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      nav.getByRole("link", { name: "設定" }).getAttribute("aria-current"),
    ).toBeNull();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("タイムライン");
    expect(h1.classList.contains("sr-only")).toBe(true);
  });

  it("marks the settings item current on /settings", async () => {
    await renderWithRouter(<AppShell>x</AppShell>, {
      path: "/settings",
      staticData: PRODUCTION_STATIC_DATA,
    });
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

  it("marks the topics item current under a topic and draws its back header", async () => {
    await renderWithRouter(<AppShell>x</AppShell>, {
      path: "/topics/$topicId",
      staticData: PRODUCTION_STATIC_DATA,
    });
    const nav = within(mainNav());
    expect(
      nav.getByRole("link", { name: "トピック" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      nav
        .getByRole("link", { name: "タイムライン" })
        .getAttribute("aria-current"),
    ).toBeNull();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("topic");
    expect(h1.getAttribute("lang")).toBe("en");
    const header = screen.getByRole("banner");
    expect(
      within(header).getByRole("link", { name: "戻る" }).getAttribute("href"),
    ).toBe("/topics");
  });

  // No nav item links to these paths, so the mark is the shell's `match`
  // and not the router's own active-link logic.
  it.each([
    ["/documents/$documentId", "トピック", "タイムライン"],
    ["/memos/$memoId/history", "タイムライン", "トピック"],
  ] as const)(
    "marks the destination a page on %s belongs to",
    async (path, current, other) => {
      await renderWithRouter(<AppShell>x</AppShell>, { path });
      const nav = within(mainNav());
      expect(
        nav.getByRole("link", { name: current }).getAttribute("aria-current"),
      ).toBe("page");
      expect(
        nav.getByRole("link", { name: other }).getAttribute("aria-current"),
      ).toBeNull();
    },
  );

  it("titles a route that declares no header with the product name", async () => {
    await renderWithRouter(<AppShell>x</AppShell>, { path: "/settings" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("fog");
  });

  it("offers an icon menu for the nav sheet and a skip link to #main", async () => {
    await renderWithRouter(<AppShell>x</AppShell>);
    const menu = screen.getByRole("button", { name: "メニュー" });
    expect(menu.getAttribute("aria-haspopup")).toBe("dialog");
    expect(menu.textContent).toBe("");
    expect(menu.querySelector("svg")?.getAttribute("data-icon")).toBe("menu");
    expect(
      screen.getByRole("link", { name: "本文へ移動" }).getAttribute("href"),
    ).toBe("#main");
    expect(screen.getByRole("main").id).toBe("main");
  });

  it("scrolls the sheet — the element the router resets and restores — not the window", async () => {
    await renderWithRouter(<AppShell>x</AppShell>);
    const selectors = getRouter().options.scrollToTopSelectors ?? [];
    expect(selectors).toHaveLength(1);
    const [selector] = selectors;
    if (typeof selector !== "string") throw new Error("not a selector");
    const sheet = screen.getByRole("main");
    expect(document.querySelector(selector)).toBe(sheet);
    expect(sheet.classList.contains("overflow-y-auto")).toBe(true);
    expect(sheet.contains(screen.getByRole("banner"))).toBe(false);
  });

  it("puts the header and the sheet on one horizontal frame", async () => {
    await renderWithRouter(<AppShell>x</AppShell>);
    const frame = ["mx-auto", "w-sheet", "md:w-sheet-md"];
    for (const element of [
      screen.getByRole("banner"),
      screen.getByRole("main"),
    ]) {
      for (const utility of frame) {
        expect(element.classList.contains(utility), utility).toBe(true);
      }
    }
  });

  it("hands the sheet to the screen as its scroll container", async () => {
    function ReadsContainer() {
      const container = useSheetScrollContainer();
      const [id, setId] = useState("none");
      useEffect(() => setId(container.current?.id ?? "viewport"), [container]);
      return <p>scrolls in {id}</p>;
    }
    await renderWithRouter(
      <AppShell>
        <ReadsContainer />
      </AppShell>,
    );
    expect(await screen.findByText("scrolls in main")).toBeTruthy();
  });

  it("reads as the viewport outside the shell", async () => {
    function ReadsContainer() {
      const container = useSheetScrollContainer();
      const [id, setId] = useState("none");
      useEffect(() => setId(container.current?.id ?? "viewport"), [container]);
      return <p>scrolls in {id}</p>;
    }
    render(<ReadsContainer />);
    expect(await screen.findByText("scrolls in viewport")).toBeTruthy();
  });
});

describe("AppShell slots", () => {
  it("puts a screen's header actions into the header, outside the sheet", async () => {
    await renderWithRouter(
      <AppShell>
        <p>body</p>
        <HeaderActions>
          <button type="button">保存</button>
        </HeaderActions>
      </AppShell>,
    );
    const save = await within(screen.getByRole("banner")).findByRole("button", {
      name: "保存",
    });
    const sheet = screen.getByRole("main");
    expect(sheet.contains(save)).toBe(false);
    expect(sheet.contains(screen.getByText("body"))).toBe(true);
    const menu = screen.getByRole("button", { name: "メニュー" });
    expect(
      save.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hosts the toasts outside the sheet, above what a screen docks at the bottom", async () => {
    function Screen() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => toast("メモを削除しました")}>
            削除
          </button>
          <BottomDock>
            <form aria-label="メモを投稿" />
          </BottomDock>
        </>
      );
    }
    await renderWithRouter(
      <AppShell>
        <Screen />
      </AppShell>,
    );
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(within(region).getByText("メモを削除しました")).toBeTruthy();
    const sheet = screen.getByRole("main");
    expect(sheet.contains(region)).toBe(false);
    const docked = await screen.findByRole("form", { name: "メモを投稿" });
    expect(sheet.contains(docked)).toBe(false);
    expect(docked.parentElement?.parentElement).toBe(region.parentElement);
    expect(
      region.compareDocumentPosition(docked) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("refuses to portal anything without the shell", () => {
    expect(() =>
      render(
        <HeaderActions>
          <button type="button">保存</button>
        </HeaderActions>,
      ),
    ).toThrow(/AppShell/);
    expect(() =>
      render(
        <BottomDock>
          <form aria-label="メモを投稿" />
        </BottomDock>,
      ),
    ).toThrow(/AppShell/);
  });
});
