import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REDIRECT_PATH,
  REDIRECT_MAX_LENGTH,
  redirectPathSchema,
  redirectSearchSchema,
  toSafeRedirect,
} from "../redirectSearch";

const mocks = vi.hoisted(() => ({
  requestUrl: new URL("https://app.example/"),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getCookie: () => undefined,
  getRequestUrl: () => mocks.requestUrl,
  setResponseHeader: () => undefined,
}));

const ORIGIN = "https://app.example";

const ACCEPTED = [
  "/",
  "/settings",
  "/settings?tab=a",
  "/a/b/c",
  "/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E",
  `/${"a".repeat(REDIRECT_MAX_LENGTH - 1)}`,
];

// Every entry is a way of saying "another origin" that a naive
// `startsWith("/")` check would wave through.
const REJECTED: ReadonlyArray<readonly [string, string]> = [
  ["protocol-relative", "//evil.example"],
  ["protocol-relative with path", "//evil.example/settings"],
  ["absolute https URL", "https://evil.example"],
  ["absolute http URL with credentials", "http://user@evil.example/"],
  ["scheme without authority", "http:/evil"],
  ["backslash the browser normalises to //", "/\\evil.example"],
  ["double backslash", "\\\\evil.example"],
  ["encoded slashes", "/%2f%2fevil.example"],
  ["encoded slash, uppercase", "/%2F/evil"],
  ["no leading slash", "evil.example"],
  ["framework-internal path", "/_serverFn/src_routes_login/loginFn"],
  ["empty string", ""],
  ["over the length ceiling", `/${"a".repeat(REDIRECT_MAX_LENGTH)}`],
  ["CRLF header injection", "/a\r\nX-Injected: y"],
  ["bare newline", "/a\nb"],
  ["NUL byte", "/a\u0000b"],
  ["DEL control character", "/a\u007fb"],
];

describe("redirectPathSchema", () => {
  it.each(ACCEPTED)("accepts the same-origin path %s", (value) => {
    expect(redirectPathSchema.safeParse(value).success).toBe(true);
  });

  it.each(REJECTED)("rejects %s", (_label, value) => {
    expect(redirectPathSchema.safeParse(value).success).toBe(false);
  });
});

describe("toSafeRedirect", () => {
  it.each(ACCEPTED)("returns %s unchanged", (value) => {
    expect(toSafeRedirect(value)).toBe(value);
  });

  it.each(REJECTED)("drops %s", (_label, value) => {
    expect(toSafeRedirect(value)).toBeUndefined();
  });

  it("passes undefined through without consulting the schema", () => {
    expect(toSafeRedirect(undefined)).toBeUndefined();
  });

  // The property the individual cases exist to protect: whatever the
  // caller wrote in the URL, resolving the result against our own origin
  // must never land on someone else's. Double-encoded separators are in
  // here because a browser decodes `%252f` only once, so they stay a
  // same-origin path even when the schema lets them through.
  it.each([
    ...ACCEPTED,
    ...REJECTED.map(([, value]) => value),
    "/%252f%252fevil.example",
    "/%252e%252e/evil",
  ])("never resolves to another origin: %s", (value) => {
    const destination = new URL(
      toSafeRedirect(value) ?? DEFAULT_REDIRECT_PATH,
      ORIGIN,
    );
    expect(destination.origin).toBe(ORIGIN);
  });
});

describe("redirectSearchSchema", () => {
  it("keeps a valid path", () => {
    expect(redirectSearchSchema.parse({ redirect: "/settings" })).toEqual({
      redirect: "/settings",
    });
  });

  // `validateSearch` runs this on every navigation, so a hostile or
  // hand-typed value has to degrade to "no redirect" rather than error
  // the whole route.
  it.each(REJECTED)("degrades %s to undefined instead of throwing", (_l, v) => {
    expect(redirectSearchSchema.parse({ redirect: v })).toEqual({
      redirect: undefined,
    });
  });

  it("treats an absent parameter as no redirect", () => {
    expect(redirectSearchSchema.parse({})).toEqual({ redirect: undefined });
  });
});

describe("requireUserId", () => {
  async function captureRedirect(): Promise<unknown> {
    const { requireUserId } = await import("../currentUser");
    try {
      await requireUserId();
    } catch (error) {
      return error;
    }
    throw new Error("expected requireUserId to redirect");
  }

  it("carries the current path back to the login screen", async () => {
    mocks.requestUrl = new URL(`${ORIGIN}/settings?tab=a`);

    const caught = await captureRedirect();

    expect(isRedirect(caught)).toBe(true);
    expect(isRedirect(caught) && caught.options.to).toBe("/login");
    expect(isRedirect(caught) && caught.options.search).toEqual({
      redirect: "/settings?tab=a",
    });
  });

  // Regression guard for the wiring, not the schema: the guard has to
  // put `getRequestUrl()` through `toSafeRedirect` or a poisoned request
  // URL becomes the post-login destination.
  it("refuses to carry a poisoned request URL", async () => {
    mocks.requestUrl = new URL(`${ORIGIN}//evil.example`);

    const caught = await captureRedirect();

    expect(isRedirect(caught)).toBe(true);
    expect(isRedirect(caught) && caught.options.search).toEqual({});
  });
});
