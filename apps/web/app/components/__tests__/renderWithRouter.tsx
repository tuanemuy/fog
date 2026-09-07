import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect } from "vitest";

/**
 * The paths a `Link` under test may point at. Every entry is a stub route
 * with no loader and no `validateSearch`: the harness draws the element,
 * not the screen behind the link.
 */
export const STUB_PATHS = ["/", "/settings", "/login", "/signup"] as const;

export type StubPath = (typeof STUB_PATHS)[number];

function buildRouter(element: ReactElement, path: string) {
  const rootRoute = createRootRoute({ component: () => element });
  const children = STUB_PATHS.map((stubPath) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: stubPath,
      component: () => null,
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
 * Draws `element` as the root of a memory-history router positioned at
 * `path`, so `Link`, `useRouter` and `useRouterState` resolve against the
 * stub tree above. Resolves once the router has loaded its initial matches.
 */
export async function renderWithRouter(
  element: ReactElement,
  { path = "/" }: { path?: StubPath | `${StubPath}?${string}` } = {},
): Promise<RouterRender> {
  const router = buildRouter(element, path);
  await router.load();
  const result = render(<RouterProvider router={router} />);
  const expectInternalHrefsToResolve = () => {
    const hrefs = [...result.container.querySelectorAll("a[href]")]
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/"));
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
