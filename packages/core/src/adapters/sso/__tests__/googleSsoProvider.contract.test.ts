import { isSystemError } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import { createGoogleSsoProvider } from "../googleSsoProvider";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const configured =
  clientId !== undefined &&
  clientId.length > 0 &&
  clientSecret !== undefined &&
  clientSecret.length > 0;

/**
 * Talks to Google's real token endpoint. A code cannot be minted without a
 * browser, so what the contract pins is the refusal path: a bogus code is
 * answered 4xx and surfaces as `SystemError(ExternalApiError)`, never as a
 * thrown provider-native value. Skipped visibly without
 * `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
 */
describe("Google SSO provider (contract)", () => {
  it.skipIf(!configured)(
    "refuses a bogus code through the shared contract",
    async () => {
      const provider = createGoogleSsoProvider({
        clientId: clientId ?? "",
        clientSecret: clientSecret ?? "",
        redirectUri: "https://example.test/auth/sso/google/callback",
      });
      await expect(
        provider.exchangeCode("google", "not-a-real-code"),
      ).rejects.toSatisfy((error) => isSystemError(error));
    },
  );

  it("is skipped without GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", () => {
    if (!configured) {
      console.warn(
        "[contract] Google SSO contract test skipped: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set",
      );
    }
    expect(true).toBe(true);
  });
});
