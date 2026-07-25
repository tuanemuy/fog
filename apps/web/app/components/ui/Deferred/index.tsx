"use client";

import { type ReactNode, type Usable, use } from "react";

/**
 * Resolves a deferred RSC payload (or any promise) on the client.
 *
 * Pair with `<Suspense fallback={...}>`: the route loader forwards the
 * `renderServerComponent(...)` promise WITHOUT awaiting it, so the loader
 * settles without waiting on the leaf and the unresolved leaf streams in
 * under the fallback. `use(promise)` suspends until the Flight payload
 * arrives. On client navigation the loader still pays the one
 * `/_serverFn/...` round trip that hands over the promise, so a slow
 * network can still cross `defaultPendingMs` — see `RoutePendingFallback`.
 *
 * This is the per-fragment streaming mechanism. For whole-route navigation
 * pending UI, use the router's `defaultPendingComponent` instead.
 */
export function Deferred<T extends ReactNode>({
  promise,
}: {
  promise: Usable<T>;
}): ReactNode {
  return use(promise);
}
