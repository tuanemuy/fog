import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "./errorResponseMiddleware";
import { noStoreMiddleware } from "./noStoreMiddleware";

/**
 * Whether the current request carries a valid session, for `beforeLoad`.
 *
 * One shared definition: per-route copies would register separate server
 * functions and drift. A navigation aid, never the guard — every server
 * execution point that reads protected data calls `requireUserId()` itself.
 * Because every protected document passes through here (`_app.tsx`'s
 * `beforeLoad`), `noStoreMiddleware` on this function is what puts
 * `Cache-Control: no-store` on every route under `_app`.
 *
 * Referenced only from route modules, which the RSC manifest already sees;
 * no side-effect import in `__root.tsx` is needed.
 *
 * **It deliberately does not reach the Durable Object**, so it cannot observe a
 * revoked epoch — putting an RPC on every navigation to find that out is not
 * worth it. That trade is only safe under a rule, and the rule is: **a server
 * function that does not go through the Durable Object must not return
 * protected data.** This one returns a single boolean used to pick which shell
 * to render. Adding a field sourced from anything but a DO call turns this into
 * a real bypass.
 */
export const readAuthStateFn = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .handler(async () => {
    const { getCurrentUserId } = await import("./currentUser");
    return { authenticated: (await getCurrentUserId()) !== null };
  });
