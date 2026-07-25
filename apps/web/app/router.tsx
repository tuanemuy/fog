import { createRouter } from "@tanstack/react-router";
import { RoutePendingFallback } from "./components/ui/RoutePendingFallback";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // The shell scrolls its sheet, not the window (ADR-030), and scroll
    // restoration only resets the window by default — a new screen would
    // otherwise open at the previous one's offset. Naming the element also
    // takes the cache off the structural `nth-child` selector.
    scrollToTopSelectors: ['[data-scroll-restoration-id="app-sheet"]'],
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
}
