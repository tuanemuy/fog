import "@tanstack/react-start/server-only";

import { getContainer } from "@repo/core/application/di/containerStore";
import { getCookie, setResponseHeader } from "@tanstack/react-start/server";
import {
  buildSessionCookie,
  SESSION_COOKIE_NAME,
  toSessionSystemError,
} from "./sessionCookie";

/**
 * Session cookie read/write for the request path.
 *
 * The identity domain has no session state and the logout usecase does no
 * domain work, so issuing and destroying the session lives here rather
 * than in a usecase (the 共通事項 section of `spec/usecases/identity.md`).
 */

/** Header sink, swappable so tests can inject a failing writer. */
export type SetCookieHeader = (value: string) => void;

const defaultSetCookieHeader: SetCookieHeader = (value) => {
  setResponseHeader("set-cookie", value);
};

function writeSessionCookie(
  token: string | null,
  setCookieHeader: SetCookieHeader,
): void {
  try {
    setCookieHeader(
      buildSessionCookie(token, { secure: import.meta.env.PROD }),
    );
  } catch (cause) {
    // The only broad catch on this path, and it exists to give the failure
    // a `kind`: an un-serializable throw would reach the client as
    // `kind: "unknown"` instead of `system`.
    throw toSessionSystemError(cause);
  }
}

export async function startSession(
  userId: string,
  setCookieHeader: SetCookieHeader = defaultSetCookieHeader,
): Promise<void> {
  const container = await getContainer();
  const token = await container.sessionCodec.issue(
    userId,
    container.clock.now(),
  );
  writeSessionCookie(token, setCookieHeader);
}

export function endSession(
  setCookieHeader: SetCookieHeader = defaultSetCookieHeader,
): void {
  writeSessionCookie(null, setCookieHeader);
}

export function readSessionToken(): string | null {
  return getCookie(SESSION_COOKIE_NAME) ?? null;
}
