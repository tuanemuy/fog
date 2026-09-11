import { type AnyRoute, createRouter } from "@tanstack/react-router";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthSheet, AuthSheetTitle } from "@/components/layout/AuthSheet";
import { useToast } from "@/components/ui/Toast";
import { requireSessionBeforeLoad } from "@/presentation/authGuard";
import { routeTree } from "@/routeTree.gen";

/**
 * ADR-008 of Issue #22: the screens on the auth sheet, by the URL each is
 * served at, and whether it needs a session.
 */
const AUTH_SHEET_SCREENS: Readonly<Record<string, boolean>> = {
  "/login": false,
  "/signup": false,
  "/password-reset": false,
  "/password-reset/done": true,
  "/ai-clients/authorize": true,
};

function productionRoutes(): {
  byId: ReadonlyMap<string, AnyRoute>;
  byPath: ReadonlyMap<string, AnyRoute>;
} {
  const router = createRouter({ routeTree });
  return {
    byId: new Map<string, AnyRoute>(Object.entries(router.routesById)),
    byPath: new Map<string, AnyRoute>(Object.entries(router.routesByPath)),
  };
}

/** The route and every layout above it, innermost first. */
function ancestry(route: AnyRoute): AnyRoute[] {
  const chain: AnyRoute[] = [];
  for (let at: AnyRoute | undefined = route; at; at = at.parentRoute) {
    chain.push(at);
  }
  return chain;
}

const passesTheSessionCheck = (route: AnyRoute) =>
  ancestry(route).some(
    (at) => at.options.beforeLoad === requireSessionBeforeLoad,
  );

describe("the auth-sheet routes", () => {
  it("serve the five screens at their own URLs, under _sheet and never under _app", () => {
    const { byPath } = productionRoutes();
    for (const path of Object.keys(AUTH_SHEET_SCREENS)) {
      const route = byPath.get(path);
      expect(route, path).toBeDefined();
      const ids = ancestry(route as AnyRoute).map((at) => at.id);
      expect(ids, path).toContain("/_sheet");
      expect(ids, path).not.toContain("/_app");
      // The auth sheet draws no header, so nothing is declared for one.
      expect(route?.options.staticData?.header, path).toBeUndefined();
    }
  });

  it("put the session check, and the no-store it reads through, before exactly the screens that need a session", () => {
    const { byPath } = productionRoutes();
    for (const [path, needsSession] of Object.entries(AUTH_SHEET_SCREENS)) {
      const route = byPath.get(path) as AnyRoute;
      expect(passesTheSessionCheck(route), path).toBe(needsSession);
    }
  });

  it("keep every app-shell screen behind the same check, held by two layouts only", () => {
    const { byId } = productionRoutes();
    const routes = [...byId.values()];
    const inTheShell = routes.filter((route) => route.id.startsWith("/_app/"));
    expect(inTheShell.length).toBeGreaterThan(0);
    for (const route of inTheShell) {
      expect(passesTheSessionCheck(route), route.id).toBe(true);
    }
    expect(
      routes
        .filter(
          (route) => route.options.beforeLoad === requireSessionBeforeLoad,
        )
        .map((route) => route.id)
        .sort(),
    ).toEqual(["/_app", "/_sheet/_authenticated"]);
  });
});

describe("AuthSheet", () => {
  it("draws one card with the lockup at its head and the screen after it, and no navigation", () => {
    render(
      <AuthSheet>
        <AuthSheetTitle id="t">ログイン</AuthSheetTitle>
        <p>screen</p>
      </AuthSheet>,
    );
    const card = screen.getByRole("main");
    const lockup = within(card).getByRole("img", { name: "fog" });
    const title = within(card).getByRole("heading", { level: 1 });
    expect(title.textContent).toBe("ログイン");
    expect(title.id).toBe("t");
    expect(
      lockup.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(card.contains(screen.getByText("screen"))).toBe(true);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("button", { name: "メニュー" })).toBeNull();
  });

  it("sits in the middle of the page both ways, a narrow card padded the same top and bottom", () => {
    render(<AuthSheet>x</AuthSheet>);
    const card = screen.getByRole("main");
    for (const utility of ["max-w-narrow", "w-full", "py-2xl"]) {
      expect(card.classList.contains(utility), utility).toBe(true);
    }
    const page = card.parentElement;
    for (const utility of ["min-h-dvh", "items-center", "justify-center"]) {
      expect(page?.classList.contains(utility), utility).toBe(true);
    }
  });

  it("hosts the toasts outside the card", () => {
    function Screen() {
      const toast = useToast();
      return (
        <button
          type="button"
          onClick={() => toast("リセットメールの送信を受け付けました")}
        >
          送る
        </button>
      );
    }
    render(
      <AuthSheet>
        <Screen />
      </AuthSheet>,
    );
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "送る" }));
    expect(
      within(region).getByText("リセットメールの送信を受け付けました"),
    ).toBeTruthy();
    expect(screen.getByRole("main").contains(region)).toBe(false);
  });
});
