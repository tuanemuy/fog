import "@tanstack/react-start/server-only";

import { getContainer } from "@repo/core/application/di/containerStore";
import { getCookie, setResponseHeader } from "@tanstack/react-start/server";
import {
  buildSessionCookie,
  issueSessionCookie,
  SESSION_COOKIE_NAME,
  toSessionSystemError,
} from "./sessionCookie";

/** Session cookie read/write for the request path. */

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
  sessionEpochOrHeader: number | SetCookieHeader = 0,
  maybeSetCookieHeader: SetCookieHeader = defaultSetCookieHeader,
): Promise<void> {
  const sessionEpoch =
    typeof sessionEpochOrHeader === "number" ? sessionEpochOrHeader : 0;
  const setCookieHeader =
    typeof sessionEpochOrHeader === "function"
      ? sessionEpochOrHeader
      : maybeSetCookieHeader;
  const container = await getContainer();
  const cookie = await issueSessionCookie(container, userId, sessionEpoch, {
    secure: import.meta.env.PROD,
  });
  try {
    setCookieHeader(cookie);
  } catch (cause) {
    throw toSessionSystemError(cause);
  }
}

export function endSession(
  setCookieHeader: SetCookieHeader = defaultSetCookieHeader,
): void {
  writeSessionCookie(null, setCookieHeader);
}

export function readSessionToken(): string | null {
  return getCookie(SESSION_COOKIE_NAME) ?? null;
}
