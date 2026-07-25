import "@tanstack/react-start/server-only";

import { getContainer } from "@repo/core/application/di/containerStore";
import { redirect } from "@tanstack/react-router";
import { getRequestUrl } from "@tanstack/react-start/server";
import { cache } from "react";
import { toSafeRedirect } from "./redirectSearch";
import { readSessionToken } from "./session";

/**
 * Authentication helpers for server components and server functions.
 *
 * These live in the presentation layer, not in `@repo/core`, because they
 * are TanStack Start specific — cookies, request headers and typed router
 * redirects (ADR-005). `getCurrentUserId` is the escape hatch of hitting
 * `getContainer()` directly: a single port call with no usecase module.
 */

export const getCurrentUserId = cache(async (): Promise<string | null> => {
  const token = readSessionToken();
  if (token === null) return null;
  const container = await getContainer();
  const verified = await container.sessionCodec.verify(
    token,
    container.clock.now(),
  );
  return verified?.userId ?? null;
});

/**
 * The authoritative guard. Every server execution point that reads
 * protected data calls this itself — `_app.tsx`'s `beforeLoad` is a
 * navigation courtesy that runs in the browser on client-side
 * transitions, so passing through it proves nothing.
 */
export async function requireUserId(): Promise<string> {
  const userId = await getCurrentUserId();
  if (userId !== null) return userId;

  const url = getRequestUrl();
  const from = toSafeRedirect(`${url.pathname}${url.search}`);
  throw redirect({
    to: "/login",
    search: from === undefined ? {} : { redirect: from },
  });
}
