import { createMiddleware } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";

/**
 * Marks the response as per-user and uncacheable.
 *
 * The authority for "this response is per-user" is the request boundary,
 * not the auth guard. `requireUserId()` also sets the header, but on a
 * per-fragment streaming route it runs inside the RSC render — after the
 * handler returned and the response headers were settled — so on its own it
 * covers neither `/_serverFn/<renderSettings>` nor, reliably, the document
 * that streams it. Setting the header *before* `next()` runs is what covers
 * every path, streaming included.
 *
 * During SSR a server function runs in-process, so a route whose
 * `beforeLoad` calls one of these also gets the header on its document
 * response. That is what stops the back button from restoring a protected
 * screen after logout.
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
