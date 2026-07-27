import { describe, expect, it } from "vitest";
import { canonicalSsoCredential, credentialLocators } from "../identityRouting";

describe("identity directory routing", () => {
  it("is deterministic, secret keyed, and emits active and previous locators", async () => {
    const keyring = {
      active: {
        generation: "v2",
        secret: "active-secret-with-at-least-32-bytes",
      },
      previous: {
        generation: "v1",
        secret: "previous-secret-with-at-least-32-bytes",
      },
      buckets: 64,
    };
    const first = await credentialLocators("email:user@example.com", keyring);
    const replay = await credentialLocators("email:user@example.com", keyring);
    expect(replay).toEqual(first);
    expect(first).toHaveLength(2);
    expect(new Set(first.map((item) => item.opaqueKey)).size).toBe(2);
    expect(first.every((item) => !item.opaqueKey.includes("user@"))).toBe(true);
  });

  it("separates identical SSO subjects by provider", () => {
    expect(canonicalSsoCredential("google", "subject")).not.toBe(
      canonicalSsoCredential("apple", "subject"),
    );
  });
});
