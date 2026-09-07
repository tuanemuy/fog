import { createMiddleware } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";

/**
 * Marks the response as per-user and uncacheable.
 *
 * The auth guard cannot own this: on a streaming route `requireUserId()`
 * runs inside the RSC render, after the response headers were settled.
 * Setting the header before `next()` covers every path, streaming included.
 * During SSR a server function runs in-process, so a `beforeLoad` that calls
 * one also stamps the document response — which is what stops the back
 * button from restoring a protected screen after logout.
 *
 * `Vary: Cookie` is a fail-safe for a CDN or reverse proxy placed in front
 * later: `/_serverFn/<id>` URLs are identical for every user.
 */
export const noStoreMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    setResponseHeader("cache-control", "no-store, private");
    setResponseHeader("vary", "cookie");
    return next();
  },
);
