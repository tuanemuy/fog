"use client";

import { type ReactNode, type Usable, use } from "react";

/**
 * Resolves an intentionally deferred promise on the client.
 *
 * Pair with `<Suspense fallback={...}>`; `use(promise)` suspends until the
 * value arrives. Do not use this to forward a `renderServerComponent(...)`
 * promise through loader data: resolve RSC handles in their server-function
 * handler. For whole-route navigation pending UI use the router's
 * `defaultPendingComponent` — see `RoutePendingFallback`.
 */
export function Deferred<T extends ReactNode>({
  promise,
}: {
  promise: Usable<T>;
}): ReactNode {
  return use(promise);
}
