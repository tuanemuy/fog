"use client";

import { type ReactNode, type Usable, use } from "react";

/**
 * Resolves a deferred RSC payload (or any promise) on the client.
 *
 * Pair with `<Suspense fallback={...}>`: the route loader forwards the
 * `renderServerComponent(...)` promise without awaiting it, and
 * `use(promise)` suspends until the Flight payload arrives. For whole-route
 * navigation pending UI use the router's `defaultPendingComponent` — see
 * `RoutePendingFallback`.
 */
export function Deferred<T extends ReactNode>({
  promise,
}: {
  promise: Usable<T>;
}): ReactNode {
  return use(promise);
}
