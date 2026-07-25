import { isSystemError } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import {
  buildSessionCookie,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  toSessionSystemError,
} from "../sessionCookie";

const attributes = (cookie: string): string[] =>
  cookie.split("; ").map((part) => part.trim());

describe("buildSessionCookie", () => {
  it("issues an HttpOnly, Lax, root-scoped cookie carrying the token", () => {
    const cookie = buildSessionCookie("token-value", { secure: false });

    expect(attributes(cookie)).toEqual([
      `${SESSION_COOKIE_NAME}=token-value`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
    ]);
  });

  it("percent-encodes the token so separators cannot break out of the value", () => {
    const cookie = buildSessionCookie("a b;c=d", { secure: false });

    expect(attributes(cookie)[0]).toBe(`${SESSION_COOKIE_NAME}=a%20b%3Bc%3Dd`);
  });

  it("appends Secure only when asked", () => {
    expect(buildSessionCookie("t", { secure: true })).toContain("; Secure");
    expect(buildSessionCookie("t", { secure: false })).not.toContain("Secure");
  });

  it("honours an explicit max age", () => {
    expect(
      buildSessionCookie("t", { secure: false, maxAgeSeconds: 60 }),
    ).toContain("Max-Age=60");
  });

  it("expires the cookie with an empty value and Max-Age=0 (TC-logout-002)", () => {
    const cookie = buildSessionCookie(null, { secure: false });

    expect(attributes(cookie)).toEqual([
      `${SESSION_COOKIE_NAME}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
    ]);
  });

  // A browser only drops a cookie when the expiring Set-Cookie repeats the
  // attribute set it was issued with.
  it("expires with the same attribute set it issues with (TC-logout-002)", () => {
    const issued = attributes(buildSessionCookie("t", { secure: true }));
    const expired = attributes(buildSessionCookie(null, { secure: true }));

    const withoutValueAndAge = (parts: string[]) =>
      parts.filter(
        (part) =>
          !part.startsWith(SESSION_COOKIE_NAME) && !part.startsWith("Max-Age="),
      );

    expect(withoutValueAndAge(expired)).toEqual(withoutValueAndAge(issued));
  });

  // An explicit max age must not survive into the expiry cookie, or logout
  // would silently re-issue a live session.
  it("ignores maxAgeSeconds when expiring (TC-logout-002)", () => {
    expect(
      buildSessionCookie(null, { secure: false, maxAgeSeconds: 3_600 }),
    ).toContain("Max-Age=0");
  });
});

describe("toSessionSystemError", () => {
  it("wraps a cookie-write failure as SystemError(SESSION_ERROR) (TC-logout-003)", () => {
    const cause = new Error("headers already sent");
    const error = toSessionSystemError(cause);

    expect(isSystemError(error)).toBe(true);
    expect(error.code).toBe("SESSION_ERROR");
    expect(error.cause).toBe(cause);
  });

  // Retrying writes the same header into the same broken response, so the
  // failure must not be advertised as retryable.
  it("is not retryable and serializes as kind: system (TC-logout-003)", () => {
    const serialized = toSessionSystemError(new Error("boom")).toSerialized();

    expect(serialized.kind).toBe("system");
    expect(serialized.code).toBe("SESSION_ERROR");
    expect(serialized.retryable).toBe(false);
  });
});
