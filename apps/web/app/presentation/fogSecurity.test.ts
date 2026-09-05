import { describe, expect, it } from "vitest";
import { isSameOriginMutation, safeReturnTo } from "./fogSecurity";

describe("safe return destination", () => {
  it("preserves a protected path, search and fragment", () => {
    expect(safeReturnTo("/timeline?memo=123#memo-123")).toBe(
      "/timeline?memo=123#memo-123",
    );
  });
  it.each([
    undefined,
    123,
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\nevil.example",
    "/login",
    "/signup?returnTo=//evil.example",
    "/",
    "/".repeat(2049),
  ])("rejects an external or looping destination: %s", (value) => {
    expect(safeReturnTo(value)).toBe("/timeline");
  });
});

describe("mutation origin", () => {
  const appUrl = "https://fog.example";
  it("accepts same-origin browser mutations", () => {
    expect(
      isSameOriginMutation(
        new Request(`${appUrl}/_serverFn`, {
          method: "POST",
          headers: { origin: appUrl, "sec-fetch-site": "same-origin" },
        }),
        appUrl,
      ),
    ).toBe(true);
  });
  it.each([
    { origin: "https://evil.example" },
    { origin: "null" },
    {},
    { origin: appUrl, "sec-fetch-site": "cross-site" },
  ])("rejects untrusted origins and absent origin", (headers) => {
    expect(
      isSameOriginMutation(
        new Request(`${appUrl}/_serverFn`, {
          method: "POST",
          headers: new Headers(Object.entries(headers)),
        }),
        appUrl,
      ),
    ).toBe(false);
  });
});
