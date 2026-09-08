import { describe, expect, it } from "vitest";
import { createResendMailSender } from "../resendMailSender";

const apiKey = process.env.MAIL_PROVIDER_API_KEY;
const to = process.env.MAIL_CONTRACT_TEST_TO;
const from = process.env.MAIL_FROM_ADDRESS ?? "fog <onboarding@resend.dev>";
const configured =
  apiKey !== undefined &&
  apiKey.length > 0 &&
  to !== undefined &&
  to.length > 0;

/**
 * Sends one real mail through Resend. Runs only with
 * `MAIL_PROVIDER_API_KEY` and `MAIL_CONTRACT_TEST_TO` in the environment;
 * otherwise it is skipped visibly rather than passing vacuously.
 */
describe("Resend mail sender (contract)", () => {
  it.skipIf(!configured)(
    "delivers a password-reset mail with the idempotency key",
    async () => {
      const sender = createResendMailSender({
        apiKey: apiKey ?? "",
        fromAddress: from,
        appUrl: "https://example.test",
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          expect(response.status).toBeLessThan(300);
          return response;
        },
      });
      await expect(
        sender.sendPasswordResetMail(
          to ?? "",
          "1.0.contract-test-token",
          `contract-${Date.now()}`,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it("is skipped without MAIL_PROVIDER_API_KEY and MAIL_CONTRACT_TEST_TO", () => {
    if (!configured) {
      console.warn(
        "[contract] Resend contract test skipped: MAIL_PROVIDER_API_KEY / MAIL_CONTRACT_TEST_TO are not set",
      );
    }
    expect(true).toBe(true);
  });
});
