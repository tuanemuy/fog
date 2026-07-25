import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "./errorResponseMiddleware";
import { noStoreMiddleware } from "./noStoreMiddleware";

/**
 * Whether the current request carries a valid session, for `beforeLoad`.
 *
 * One definition shared by every route that branches on sign-in state:
 * declaring it per route would register separate server functions and let
 * the definitions drift. This is a navigation aid, never the guard — every
 * server execution point that reads protected data calls `requireUserId()`
 * itself (.issue/1/adr.md ADR-005).
 *
 * It is, however, the one call every protected document passes through
 * (`_app.tsx`'s `beforeLoad`), which is why `noStoreMiddleware` sits here:
 * it is what puts `Cache-Control: no-store` on every route under `_app`
 * (manual TC-23).
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
