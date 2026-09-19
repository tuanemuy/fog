import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  RouterProvider,
  type StaticDataRouteOption,
} from "@tanstack/react-router";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect } from "vitest";

/**
 * The paths a `Link` under test may point at. Every entry is a stub route
 * with no loader and no `validateSearch`: the harness draws the element,
 * not the screen behind the link.
 */
export const STUB_PATHS = [
  "/",
  "/settings",
  "/login",
  "/signup",
  "/password-reset",
  "/password-reset/done",
  "/ai-clients/authorize",
  "/memos/$memoId/history",
  "/topics",
  "/topics/$topicId",
  "/topics/$topicId/documents/new",
  "/documents/$documentId",
  "/documents/$documentId/edit",
  "/documents/$documentId/history",
  "/search",
  "/trash",
] as const;

export type StubPath = (typeof STUB_PATHS)[number];

/**
 * Paths the request Worker answers before the router sees them (the bare
 * SSO handlers, `server.cloudflare.ts`). An anchor pointing under one of
 * these is a real link with nothing in the route tree behind it, so the
 * resolution check skips it rather than failing on a route it cannot have.
 */
export const BARE_HANDLER_PREFIXES = ["/auth/sso/", "/export"] as const;

/** `staticData` for some stub routes — the header a shell under test reads. */
export type StubStaticData = Partial<Record<StubPath, StaticDataRouteOption>>;

function buildRouter(
  element: ReactElement,
  path: string,
  staticData: StubStaticData,
) {
  const rootRoute = createRootRoute({ component: () => element });
  const children = STUB_PATHS.map((stubPath) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: stubPath,
      component: () => null,
      staticData: staticData[stubPath] ?? {},
    }),
  );
  return createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

export type RouterRender = RenderResult & {
  router: ReturnType<typeof buildRouter>;
  /**
   * Feeds every internal `href` on the page back through `router.matchRoutes`
   * so a `to` with no stub behind it goes red instead of silently building a
   * URL nothing serves. Reads the pathname only; anchors whose href does not
   * start with `/` are not checked.
   */
  expectInternalHrefsToResolve: () => string[];
};

/**
 * The invocation order of every `router.clearCache()` call that dropped the
 * whole cache. The router makes its own calls while it loads
 * (`clearExpiredCache`, which passes a filter), so only the argument-less ones
 * came from the component under test.
 */
export function cacheDrops(clearCache: {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
    invocationCallOrder: readonly number[];
  };
}): number[] {
  return clearCache.mock.calls.flatMap((args, index) =>
    args.length === 0 ? [clearCache.mock.invocationCallOrder[index] ?? 0] : [],
  );
}

/** A screen of the tree `renderWithReloadingRoutes` builds. */
export type ReloadingScreen = {
  path: StubPath;
  element: ReactElement;
  /** What the route draws once its subject is gone. */
  missing: string;
  /** Once this reads true, the loader answers `notFound()`. */
  gone?: () => boolean;
};

/**
 * Draws `screens` as real routes that do have loaders: each carries
 * `staleTime: 0` — what the two deleting screens carry under `pnpm dev`, where
 * a load at the same location re-reads the matches already on the page — and a
 * loader that answers `notFound()` once the screen's `gone` reads true, the way
 * a screen whose subject was just moved to the trash does. `runs` counts every
 * loader run by path and `missing` collects the paths whose 「…が見つかりません」
 * was drawn at any point, so a delete can be judged by what it re-read rather
 * than by which router method it called.
 *
 * The stub tree above cannot answer that: its routes have no loaders, so a
 * reconciliation that re-reads the screen it is leaving looks the same there
 * as one that does not.
 *
 * `runs` already counts more than one run per path before the render settles
 * (mounting `RouterProvider` loads at the unchanged location, which at
 * `staleTime: 0` re-reads): take the count as a baseline after the render and
 * compare against it.
 *
 * Returns the render plus the router, `runs` (loader runs by path) and
 * `missing` (the paths whose sentence was drawn).
 */
export async function renderWithReloadingRoutes(
  screens: readonly ReloadingScreen[],
  at: string,
) {
  const runs = new Map<string, number>();
  const missing = new Set<string>();
  const rootRoute = createRootRoute();
  // The rest of `STUB_PATHS` comes along loaderless, so the shell's own links
  // resolve here the same way they do in the harness above.
  const children = STUB_PATHS.map((stubPath) => {
    const screen = screens.find((s) => s.path === stubPath);
    if (screen === undefined) {
      return createRoute({
        getParentRoute: () => rootRoute,
        path: stubPath,
        component: () => null,
      });
    }
    return createRoute({
      getParentRoute: () => rootRoute,
      path: stubPath,
      staleTime: 0,
      loader: () => {
        runs.set(stubPath, (runs.get(stubPath) ?? 0) + 1);
        if (screen.gone?.() === true) throw notFound();
        return null;
      },
      notFoundComponent: () => {
        missing.add(stubPath);
        return <p>{screen.missing}</p>;
      },
      component: () => screen.element,
    });
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  await router.load();
  const result = render(<RouterProvider router={router} />);
  return { ...result, router, runs, missing };
}

/**
 * Draws `element` as the root of a memory-history router positioned at
 * `path`, so `Link`, `useRouter` and `useRouterState` resolve against the
 * stub tree above. `staticData` is handed to the named stubs as their route
 * option. Resolves once the router has loaded its initial matches.
 */
export async function renderWithRouter(
  element: ReactElement,
  {
    path = "/",
    staticData = {},
  }: {
    path?: StubPath | `${StubPath}?${string}`;
    staticData?: StubStaticData;
  } = {},
): Promise<RouterRender> {
  const router = buildRouter(element, path, staticData);
  await router.load();
  const result = render(<RouterProvider router={router} />);
  const expectInternalHrefsToResolve = () => {
    const hrefs = [...result.container.querySelectorAll("a[href]")]
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter(
        (href) =>
          href.startsWith("/") &&
          !BARE_HANDLER_PREFIXES.some((prefix) => href.startsWith(prefix)),
      );
    for (const href of hrefs) {
      const { pathname } = new URL(href, "http://harness.local");
      const matches = router.matchRoutes(pathname, {});
      const resolved =
        matches.length > 0 && matches.every((match) => !match.globalNotFound);
      expect(resolved, `href ${href} matches no stub route`).toBe(true);
    }
    return hrefs;
  };
  return { ...result, router, expectInternalHrefsToResolve };
}
