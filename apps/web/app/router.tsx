import { createRouter } from "@tanstack/react-router";
import type { PageHeaderDeclaration } from "./components/layout/PageHeader";
import { SHEET_SCROLL_SELECTOR } from "./components/layout/sheet";
import { NotFound } from "./components/ui/NotFound";
import { RouteError } from "./components/ui/RouteError";
import { RoutePendingFallback } from "./components/ui/RoutePendingFallback";
import { reportRouteError } from "./presentation/errorDisplay";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // The shell scrolls its sheet, not the window, and scroll restoration
    // only resets the window by default — a new screen would otherwise open
    // at the previous one's offset.
    scrollToTopSelectors: [SHEET_SCROLL_SELECTOR],
    defaultPreload: "intent",
    // A screen's failure and its not-found are drawn in its layout's frame by
    // these two. The root and the two layouts under it declare their own error
    // component; no route declares a not-found component, because a loader's
    // `notFound()` is drawn by the nearest route up the tree that has one —
    // any declared above a screen would pull its 404 out of the frame.
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFound,
    defaultOnCatch: reportRouteError,
    // A URL no route serves is answered at the root, which frames it on the
    // auth sheet — never in whichever layout matched a prefix of it.
    notFoundMode: "root",
    defaultPendingComponent: RoutePendingFallback,
    // Skip the fallback for sub-200ms navigations so it doesn't flash...
    defaultPendingMs: 200,
    // ...and once shown, keep it up for at least 300ms to avoid a flicker.
    defaultPendingMinMs: 300,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
  interface StaticDataRouteOption {
    /**
     * The header `AppShell` draws for this route.
     * Every screen under `_app` declares one; the deepest declaring match
     * wins. The auth sheet (`_sheet`) draws no header, and its screens
     * declare none.
     */
    header?: PageHeaderDeclaration;
  }
}
