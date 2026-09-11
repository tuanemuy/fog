import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  RouterProvider,
} from "@tanstack/react-router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSheetRouteError } from "@/components/layout/AuthSheet";
import { Deferred } from "@/components/ui/Deferred";
import { NotFound } from "@/components/ui/NotFound";
import { RouteError } from "@/components/ui/RouteError";
import { RoutePendingFallback } from "@/components/ui/RoutePendingFallback";
import { reportRouteError } from "@/presentation/errorDisplay";
import { getRouter } from "@/router";

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

const production = getRouter();

function productionRoute(id: string): AnyRoute {
  const route: AnyRoute | undefined = new Map<string, AnyRoute>(
    Object.entries(production.routesById),
  ).get(id);
  if (route === undefined) throw new Error(`no route ${id}`);
  return route;
}

/** A production option the stub tree reuses; it has to be there. */
function declared<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is not declared`);
  return value;
}

const ROOT = productionRoute("__root__");
const APP = productionRoute("/_app");
const SHEET = productionRoute("/_sheet");

/** A failure whose words must never reach the page. */
const LEAK = "connect ECONNREFUSED 10.0.0.4:5432";

/** What each stub step does on its next run: throw, or let the route through. */
type Step = { fail: boolean };

/**
 * The production frames and boundaries over stub screens: the root's, `_app`'s
 * and `_sheet`'s own `component` and `errorComponent`, and the router's
 * defaults and not-found mode for everything else (no route declares a
 * not-found component — the first describe block holds that). Each layer's guard or loader fails
 * while its step says so.
 */
function drawAt(
  path: string,
  steps: Partial<
    Record<"root" | "app" | "sheet" | "guard" | "screen" | "stream", Step>
  >,
) {
  const failWhen = (step: Step | undefined) => () => {
    if (step?.fail) throw new Error(LEAK);
  };
  const screenLoader = vi.fn(failWhen(steps.screen));
  // The streaming form: the loader settles at once and hands over the
  // fragment's promise, which fails while its step says so.
  const streamLoader = vi.fn(() => ({
    Fragment: steps.stream?.fail
      ? Promise.reject(new Error(LEAK))
      : Promise.resolve(<p>一覧の中身</p>),
  }));
  const root = createRootRoute({
    beforeLoad: failWhen(steps.root),
    component: declared(ROOT.options.component, "root component"),
    errorComponent: declared(
      ROOT.options.errorComponent,
      "root errorComponent",
    ),
  });
  const app = createRoute({
    getParentRoute: () => root,
    id: "_app",
    beforeLoad: failWhen(steps.app),
    component: declared(APP.options.component, "_app component"),
    errorComponent: declared(APP.options.errorComponent, "_app errorComponent"),
  });
  const timeline = createRoute({
    getParentRoute: () => app,
    path: "/",
    staticData: { header: { kind: "top", title: "タイムライン" } },
    loader: screenLoader,
    component: () => <p>タイムラインの中身</p>,
  });
  const topic = createRoute({
    getParentRoute: () => app,
    path: "/topics/$topicId",
    staticData: {
      header: { kind: "back", entity: "topic", back: "/topics", h1: "header" },
    },
    loader: () => {
      throw notFound();
    },
    component: () => <p>トピックの中身</p>,
  });
  const streamed = createRoute({
    getParentRoute: () => app,
    path: "/stream",
    staticData: { header: { kind: "top", title: "一覧" } },
    loader: streamLoader,
    component: function StreamedPage() {
      const { Fragment } = streamed.useLoaderData();
      return (
        <Suspense fallback={<p>一覧のスケルトン</p>}>
          <Deferred promise={Fragment} />
        </Suspense>
      );
    },
  });
  const sheet = createRoute({
    getParentRoute: () => root,
    id: "_sheet",
    beforeLoad: failWhen(steps.sheet),
    component: declared(SHEET.options.component, "_sheet component"),
    errorComponent: declared(
      SHEET.options.errorComponent,
      "_sheet errorComponent",
    ),
  });
  const login = createRoute({
    getParentRoute: () => sheet,
    path: "/login",
    component: () => <p>ログインの中身</p>,
  });
  const guarded = createRoute({
    getParentRoute: () => sheet,
    id: "_authenticated",
    beforeLoad: failWhen(steps.guard),
  });
  const done = createRoute({
    getParentRoute: () => guarded,
    path: "/password-reset/done",
    component: () => <p>再設定の完了</p>,
  });
  const { options } = production;
  const router = createRouter({
    routeTree: root.addChildren([
      app.addChildren([timeline, topic, streamed]),
      sheet.addChildren([login, guarded.addChildren([done])]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultErrorComponent: declared(
      options.defaultErrorComponent,
      "defaultErrorComponent",
    ),
    defaultNotFoundComponent: declared(
      options.defaultNotFoundComponent,
      "defaultNotFoundComponent",
    ),
    notFoundMode: declared(options.notFoundMode, "notFoundMode"),
  });
  render(<RouterProvider router={router} />);
  return { router, screenLoader, streamLoader };
}

/** The app shell is up: its navigation and its sheet. */
function appSheet() {
  expect(
    screen.getByRole("navigation", { name: "メインナビゲーション" }),
  ).toBeTruthy();
  return screen.getByRole("main");
}

/** The auth sheet is up: one card with the lockup, and no navigation. */
function authCard() {
  expect(screen.queryByRole("navigation")).toBeNull();
  expect(screen.queryByRole("banner")).toBeNull();
  const card = screen.getByRole("main");
  expect(within(card).getByRole("img", { name: "fog" })).toBeTruthy();
  return card;
}

// The boundaries log what they catch (and the router warns under test);
// jsdom has no `scrollTo` for the router's scroll reset.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the production boundaries (ADR-009 of Issue #22)", () => {
  it("are the router's defaults for every screen, logged by the router", () => {
    expect(production.options.defaultErrorComponent).toBe(RouteError);
    expect(production.options.defaultNotFoundComponent).toBe(NotFound);
    expect(production.options.defaultPendingComponent).toBe(
      RoutePendingFallback,
    );
    expect(production.options.defaultOnCatch).toBe(reportRouteError);
    expect(production.options.notFoundMode).toBe("root");
  });

  it("are declared by the root and the two layouts under it only, all on the auth sheet", () => {
    const routes: AnyRoute[] = Object.values(production.routesById);
    const declaring = routes.filter(
      (route) => route.options.errorComponent !== undefined,
    );
    expect(declaring.map((route) => route.id).sort()).toEqual(
      ["/_app", "/_sheet", "__root__"].sort(),
    );
    for (const route of declaring) {
      expect(route.options.errorComponent, route.id).toBe(AuthSheetRouteError);
    }
  });

  // A loader's `notFound()` is drawn by the nearest route up the tree that
  // declares a not-found component; one above a screen would take its 404
  // out of the screen's frame.
  it("leave the not-found to the router's default everywhere", () => {
    const routes: AnyRoute[] = Object.values(production.routesById);
    expect(
      routes
        .filter((route) => route.options.notFoundComponent !== undefined)
        .map((route) => route.id),
    ).toEqual([]);
  });
});

describe("in the app shell", () => {
  it("draws a screen's failure in the sheet under the header and the nav, and never the error's words", async () => {
    drawAt("/", { screen: { fail: true } });
    const alert = await screen.findByRole("alert");
    const sheet = appSheet();
    expect(sheet.contains(alert)).toBe(true);
    expect(within(alert).getByText("読み込めませんでした").tagName).toBe("P");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "タイムライン",
    );
    expect(document.body.textContent).not.toContain(LEAK);
  });

  it("reruns the screen's loader on 再試行 and draws the screen in the sheet", async () => {
    const step = { fail: true };
    const { screenLoader } = drawAt("/", { screen: step });
    const retry = await screen.findByRole("button", { name: "再試行" });
    expect(screenLoader).toHaveBeenCalledTimes(1);
    step.fail = false;

    fireEvent.click(retry);

    const content = await screen.findByText("タイムラインの中身");
    expect(appSheet().contains(content)).toBe(true);
    expect(screenLoader).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays on the route error, ready to try again, when 再試行 fails too", async () => {
    const { screenLoader } = drawAt("/", { screen: { fail: true } });
    fireEvent.click(await screen.findByRole("button", { name: "再試行" }));

    await waitFor(() => expect(screenLoader).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "再試行" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(appSheet().contains(screen.getByRole("alert"))).toBe(true);
    expect(screen.queryByText("タイムラインの中身")).toBeNull();
  });

  it("draws a streamed fragment's failure where its skeleton was, and streams it afresh on 再試行", async () => {
    const step = { fail: true };
    const { streamLoader } = drawAt("/stream", { stream: step });
    const alert = await screen.findByRole("alert");
    expect(appSheet().contains(alert)).toBe(true);
    expect(screen.queryByText("一覧のスケルトン")).toBeNull();
    expect(document.body.textContent).not.toContain(LEAK);
    step.fail = false;

    fireEvent.click(within(alert).getByRole("button", { name: "再試行" }));

    const content = await screen.findByText("一覧の中身");
    expect(appSheet().contains(content)).toBe(true);
    expect(streamLoader).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("draws a screen's not-found in the sheet with the way back to the timeline", async () => {
    drawAt("/topics/x", {});
    const sentence = await screen.findByText("ページが見つかりません");
    const sheet = appSheet();
    expect(sheet.contains(sentence)).toBe(true);
    expect(sentence.tagName).toBe("P");
    expect(
      within(sheet)
        .getByRole("link", { name: "タイムラインへ" })
        .getAttribute("href"),
    ).toBe("/");
    expect(screen.queryByText("トピックの中身")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("on the auth sheet", () => {
  it.each([
    ["the root", "/", "root"],
    ["_app itself (its session check)", "/", "app"],
    ["_sheet itself", "/login", "sheet"],
  ] as const)(
    "draws a failure of %s on a sheet of its own, the sentence as the page's h1",
    async (_, path, layer) => {
      drawAt(path, { [layer]: { fail: true } });
      const alert = await screen.findByRole("alert");
      expect(authCard().contains(alert)).toBe(true);
      expect(within(alert).getByRole("heading", { level: 1 }).textContent).toBe(
        "読み込めませんでした",
      );
      expect(document.body.textContent).not.toContain(LEAK);
    },
  );

  it("brings the app shell back once _app's check passes on 再試行", async () => {
    const step = { fail: true };
    drawAt("/", { app: step });
    const retry = await screen.findByRole("button", { name: "再試行" });
    authCard();
    step.fail = false;

    fireEvent.click(retry);

    const content = await screen.findByText("タイムラインの中身");
    expect(appSheet().contains(content)).toBe(true);
  });

  it("draws the failure of a screen on it inside the card, as the page's h1", async () => {
    drawAt("/password-reset/done", { guard: { fail: true } });
    const alert = await screen.findByRole("alert");
    const card = authCard();
    expect(card.contains(alert)).toBe(true);
    expect(within(card).getByRole("heading", { level: 1 }).textContent).toBe(
      "読み込めませんでした",
    );
  });

  it.each(["/nowhere", "/topics/x/nowhere", "/login/nowhere"])(
    "answers %s — a URL no route serves — with the 404, never in the shell",
    async (path) => {
      drawAt(path, {});
      const heading = await screen.findByRole("heading", { level: 1 });
      expect(heading.textContent).toBe("ページが見つかりません");
      const card = authCard();
      expect(card.contains(heading)).toBe(true);
      expect(
        within(card)
          .getByRole("link", { name: "タイムラインへ" })
          .getAttribute("href"),
      ).toBe("/");
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
});
