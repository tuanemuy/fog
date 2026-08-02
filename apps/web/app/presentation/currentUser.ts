import "@tanstack/react-start/server-only";

import { getContainer } from "@repo/core/application/di/containerStore";
import { redirect } from "@tanstack/react-router";
import { getRequestUrl, setResponseHeader } from "@tanstack/react-start/server";
import { cache } from "react";
import { toSafeRedirect } from "./redirectSearch";
import { readSessionToken } from "./session";

/**
 * Authentication helpers for server components and server functions.
 *
 * `getCurrentUserId` is the escape hatch of hitting `getContainer()`
 * directly: a single port call with no usecase module.
 */

/**
 * The verified session, or `null`.
 *
 * `epoch` travels with the id because the Durable Object needs it: this side
 * can only tell that a token was signed by us, and the account's current
 * `sessionEpoch` is what decides whether it is still good.
 */
export type SessionIdentity = Readonly<{ userId: string; epoch: number }>;

export const getCurrentUserId = cache(
  async (): Promise<SessionIdentity | null> => {
    const token = readSessionToken();
    if (token === null) return null;
    const container = await getContainer();
    const verified = await container.sessionCodec.verify(
      token,
      container.clock.now(),
    );
    return verified === null
      ? null
      : { userId: verified.userId, epoch: verified.epoch };
  },
);

/**
 * A front check on the token's authenticity — **not the authoritative guard**.
 *
 * Authorization is decided by the epoch guard inside the user's Durable
 * Object: a token can be perfectly well-signed and still belong to a session
 * that a password change or an unlink has revoked, and only the DO knows that.
 * `_app.tsx`'s `beforeLoad` is weaker still — a navigation courtesy that runs
 * in the browser on client-side transitions — so passing through it proves
 * nothing at all.
 */
export async function requireUserId(): Promise<SessionIdentity> {
  const identity = await getCurrentUserId();
  if (identity !== null) {
    // Belt to `noStoreMiddleware`'s braces. This alone does NOT cover a
    // per-fragment streaming route: there the guard runs inside the RSC
    // render, after the response headers were settled. Anything that returns
    // protected data must also carry `noStoreMiddleware`.
    setResponseHeader("cache-control", "no-store, private");
    return identity;
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
