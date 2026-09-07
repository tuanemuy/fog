import "@tanstack/react-start/server-only";

import { getContainer } from "@repo/core/application/di/containerStore";
import { isSystemError, SystemErrorCode } from "@repo/core/application/errors";
import { redirect } from "@tanstack/react-router";
import { getRequestUrl } from "@tanstack/react-start/server";
import { toSafeRedirect } from "./redirectSearch";
import { readSessionToken } from "./session";

/**
 * The session check every protected server execution point runs.
 *
 * Verifies the cookie's signature and expiry, then reads the account's
 * current `sessionEpoch` from the user's own Durable Object — on every
 * request, never cached — and treats a generation the object has moved past
 * as no session. Every rejection (no cookie, bad signature, expired, epoch
 * mismatch, an account whose object was never initialised) is the same
 * `null`; nothing about why reaches the caller. The never-initialised case
 * arrives as `SystemError(NotInitialized)` from the gateway and is folded
 * here — and only here — because a token naming such an object is a stale
 * or forged credential, not a broken server.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const token = readSessionToken();
  if (token === null) return null;
  const container = await getContainer();
  const verified = await container.sessionCodec.verify(
    token,
    container.clock.now(),
  );
  if (verified === null) return null;
  const account = await readAccountStateOrNull(container, verified.userId);
  if (account === null || account.status !== "active") return null;
  if (account.sessionEpoch > verified.sessionEpoch) return null;
  return verified.userId;
}

async function readAccountStateOrNull(
  container: Awaited<ReturnType<typeof getContainer>>,
  userId: string,
) {
  try {
    return await container.identityGateway.readAccountState(userId);
  } catch (error) {
    if (isSystemError(error) && error.code === SystemErrorCode.NotInitialized) {
      return null;
    }
    throw error;
  }
}

/**
 * The guard. Bounces to `/login`, carrying the current path so the login
 * screen can return here (S-AC-03). The carried value passes the same
 * same-origin check the login route applies on the way back.
 */
export async function requireUserId(): Promise<string> {
  const userId = await getCurrentUserId();
  if (userId !== null) return userId;
  const url = getRequestUrl();
  const current = `${url.pathname}${url.search}`;
  const target = toSafeRedirect(current);
  throw redirect({
    to: "/login",
    search: target === undefined || target === "/" ? {} : { redirect: target },
  });
}
