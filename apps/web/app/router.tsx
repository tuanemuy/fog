import { createRouter } from "@tanstack/react-router";
import type { PageHeaderDeclaration } from "./components/layout/PageHeader";
import { SHEET_SCROLL_SELECTOR } from "./components/layout/sheet";
import { RoutePendingFallback } from "./components/ui/RoutePendingFallback";
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
     * The header `AppShell` draws for this route (ADR-006 of Issue #22).
     * Every screen under `_app` declares one; the deepest declaring match
     * wins.
     */
    header?: PageHeaderDeclaration;
  }
}
