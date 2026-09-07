"use client";

import { type ReactNode, type Usable, use, useDeferredValue } from "react";

/**
 * Resolves a deferred RSC payload (or any promise) on the client.
 *
 * Pair with `<Suspense fallback={...}>`: the route loader forwards the
 * `renderServerComponent(...)` promise WITHOUT awaiting it, so navigation
 * settles immediately and the unresolved leaf streams in under the fallback.
 * `use(promise)` suspends until the Flight payload arrives.
 *
 * The promise goes through `useDeferredValue` so that a *replacement* — the
 * fresh promise a `router.invalidate()` hands out after a mutation — keeps
 * the already-resolved content on screen while the new payload loads,
 * instead of dropping the boundary back to its fallback. Router state
 * updates arrive through an external store and cannot ride a transition,
 * so this is what keeps an optimistic entry visible until the refetched list
 * replaces it.
 *
 * This is the per-fragment streaming mechanism. For whole-route navigation
 * pending UI, use the router's `defaultPendingComponent` instead.
 */
export function Deferred<T extends ReactNode>({
  promise,
}: {
  promise: Usable<T>;
}): ReactNode {
  return use(useDeferredValue(promise));
}
