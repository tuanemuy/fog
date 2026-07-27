import "@tanstack/react-start/server-only";

import { getContainer } from "@repo/core/application/di/containerStore";
import { redirect } from "@tanstack/react-router";
import { getRequestUrl, setResponseHeader } from "@tanstack/react-start/server";
import { cache } from "react";
import { resolveAuthenticatedUserId } from "./authenticatedSession";
import { toSafeRedirect } from "./redirectSearch";
import { readSessionToken } from "./session";

/**
 * Authentication helpers for server components and server functions.
 *
 * `getCurrentUserId` is the escape hatch of hitting `getContainer()`
 * directly: a single port call with no usecase module.
 */

export const getCurrentUserId = cache(async (): Promise<string | null> => {
  const token = readSessionToken();
  if (token === null) return null;
  const container = await getContainer();
  return resolveAuthenticatedUserId(container, token);
});

/**
 * The authoritative guard. Every server execution point that reads
 * protected data calls this itself — `_app.tsx`'s `beforeLoad` is a
 * navigation courtesy that runs in the browser on client-side
 * transitions, so passing through it proves nothing.
 */
export async function requireUserId(): Promise<string> {
  const userId = await getCurrentUserId();
  if (userId !== null) {
    // Belt to `noStoreMiddleware`'s braces. This alone does NOT cover a
    // per-fragment streaming route: there the guard runs inside the RSC
    // render, after the response headers were settled. Anything that returns
    // protected data must also carry `noStoreMiddleware`.
    setResponseHeader("cache-control", "no-store, private");
    return userId;
  }

  // `getRequestUrl()` is whatever URL is being served, which for a server
  // function is `/_serverFn/...` — never a place to send a signed-in user
  // back to. `toSafeRedirect` drops those, leaving the default landing page.
  const url = getRequestUrl();
  const from = toSafeRedirect(`${url.pathname}${url.search}`);
  throw redirect({
    to: "/login",
    search: from === undefined ? {} : { redirect: from },
  });
}
