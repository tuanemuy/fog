import { createHash } from "node:crypto";
import { createGoogleIdentity } from "@repo/core/adapters/fog/googleIdentity";
import { createSmtpResetMailer } from "@repo/core/adapters/fog/smtpMailer";
import { SystemClock } from "@repo/core/application/ports/clock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAccountFixtures } from "../../scripts/accountFixtures";
import { readFogAccountConfig } from "./fogAccountConfig";

let fixture: Awaited<ReturnType<typeof startAccountFixtures>>;
beforeAll(async () => {
  fixture = await startAccountFixtures({
    issuerPort: 3467,
    mailPort: 1035,
    mailboxPort: 8035,
  });
});
afterAll(async () => {
  await fixture?.close();
});
const adapter = () =>
  createGoogleIdentity({
    clientId: fixture.clientId,
    clientSecret: fixture.clientSecret,
    appUrl: "http://localhost:3000",
    clock: SystemClock,
    fixtureOrigin: fixture.issuer,
  });
async function authorize(mode = "normal") {
  const identity = adapter();
  const codeVerifier = "a".repeat(43);
  const url = identity.authorizationUrl({
    state: "state-value",
    nonce: "nonce-value",
    codeChallenge: createHash("sha256")
      .update(codeVerifier)
      .digest("base64url"),
  });
  const parsed = new URL(url);
  expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  expect(parsed.searchParams.get("redirect_uri")).toBe(
    "http://localhost:3000/auth/google/callback",
  );
  const page = await fetch(url);
  const html = await page.text();
  const request = html.match(/name="request" value="([^"]+)"/)?.[1];
  expect(request).toBeTruthy();
  const approved = await fetch(new URL("/approve", fixture.issuer), {
    method: "POST",
    body: new URLSearchParams({
      request: request ?? "",
      email: "provider@example.test",
      subject: "provider-subject",
      mode,
      decision: "allow",
    }),
    redirect: "manual",
  });
  const callback = new URL(approved.headers.get("location") ?? "");
  expect(callback.searchParams.get("state")).toBe("state-value");
  return {
    identity,
    code: callback.searchParams.get("code") ?? "",
    codeVerifier,
    nonce: "nonce-value",
  };
}
describe("concrete account provider contracts", () => {
  it("exchanges S256 once and verifies a signed OIDC identity through HTTP", async () => {
    const { identity, ...input } = await authorize();
    expect(await identity.exchange(input)).toEqual({
      subject: "provider-subject",
      email: "provider@example.test",
      emailVerified: true,
    });
    await expect(identity.exchange(input)).rejects.toMatchObject({
      code: "GOOGLE_AUTH_FAILED",
    });
  });
  it.each([
    "bad-signature",
    "bad-issuer",
    "bad-audience",
    "bad-nonce",
    "expired",
    "unverified",
  ])("rejects %s without exposing provider data", async (mode) => {
    const { identity, ...input } = await authorize(mode);
    await expect(identity.exchange(input)).rejects.toMatchObject({
      code: "GOOGLE_AUTH_FAILED",
    });
  });
  it("rejects wrong PKCE", async () => {
    const { identity, ...input } = await authorize();
    await expect(
      identity.exchange({ ...input, codeVerifier: "wrong" }),
    ).rejects.toMatchObject({ code: "GOOGLE_AUTH_FAILED" });
  });
  it("sends recovery text through a loopback SMTP connection", async () => {
    const mailer = createSmtpResetMailer({
      host: "127.0.0.1",
      port: 1035,
      from: "fog@localhost",
      appUrl: "http://localhost:3000",
      local: true,
    });
    await mailer.sendPasswordReset({
      id: "stable-test-message",
      to: "provider@example.test",
      resetUrl: "http://localhost:3000/password/reset?token=local-test-token",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]?.to).toEqual(["provider@example.test"]);
    expect(fixture.messages[0]?.text).toContain(
      "http://localhost:3000/password/reset?token=local-test-token",
    );
  });
  it("prevents local fixture wiring on external app URLs", () => {
    expect(() => adapter()).not.toThrow();
    expect(() =>
      createGoogleIdentity({
        clientId: "id",
        clientSecret: "secret",
        appUrl: "https://fog.example",
        clock: SystemClock,
        fixtureOrigin: fixture.issuer,
      }),
    ).toThrow();
    expect(() =>
      createSmtpResetMailer({
        host: "127.0.0.1",
        port: 1035,
        from: "fog@localhost",
        appUrl: "https://fog.example",
        local: true,
      }),
    ).toThrow();
    expect(() =>
      readFogAccountConfig(
        { FOG_OIDC_FIXTURE_ORIGIN: fixture.issuer },
        "https://fog.example",
      ),
    ).toThrow();
    expect(() =>
      readFogAccountConfig(
        { FOG_SMTP_LOCAL: "true", FOG_SMTP_HOST: "127.0.0.1" },
        "https://fog.example",
      ),
    ).toThrow();
  });
  it("production Google endpoint configuration cannot be overridden", () => {
    const identity = createGoogleIdentity({
      clientId: "id",
      clientSecret: "secret",
      appUrl: "https://fog.example",
      clock: SystemClock,
    });
    expect(
      new URL(
        identity.authorizationUrl({
          state: "x",
          nonce: "y",
          codeChallenge: "z",
        }),
      ).origin,
    ).toBe("https://accounts.google.com");
  });
});
