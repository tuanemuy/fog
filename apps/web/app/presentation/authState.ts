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
 */
export const readAuthStateFn = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .handler(async () => {
    const { getCurrentUserId } = await import("./currentUser");
    return { authenticated: (await getCurrentUserId()) !== null };
  });
