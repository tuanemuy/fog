import { SystemError, SystemErrorCode } from "@repo/core/application/errors";

/**
 * Pure cookie-string arithmetic for the session cookie.
 *
 * Deliberately free of framework imports: `session.ts` owns the header
 * read/write and is `server-only`, while everything decidable without a
 * request lives here so it stays reachable from the node test pool.
 */

export const SESSION_COOKIE_NAME = "fog_session";

/** 7 days, matching the token TTL the session codec issues. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type SessionCookieOptions = Readonly<{
  secure: boolean;
  maxAgeSeconds?: number;
}>;

/**
 * Serializes the `Set-Cookie` value for the session.
 *
 * Pass `null` to expire it: an explicit `Max-Age=0` with an empty value,
 * which is the only reliable way to drop a cookie the browser already
 * holds. The attribute set (`HttpOnly`, `SameSite=Lax`, `Path=/`) must
 * match between issue and expiry or the browser keeps the original.
 */
export function buildSessionCookie(
  token: string | null,
  options: SessionCookieOptions,
): string {
  const maxAge =
    token === null
      ? 0
      : (options.maxAgeSeconds ?? SESSION_COOKIE_MAX_AGE_SECONDS);
  const parts = [
    `${SESSION_COOKIE_NAME}=${token === null ? "" : encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Wraps an unexpected cookie-header failure as a `SystemError`.
 *
 * `serializeError` falls back to `kind: "unknown"` for anything that is
 * not a `SerializableError`, so a bare throw from the header write would
 * never reach the client as `kind: "system"`.
 */
export function toSessionSystemError(cause: unknown): SystemError {
  return new SystemError(
    SystemErrorCode.SessionError,
    "Failed to write the session cookie",
    cause,
  );
}
