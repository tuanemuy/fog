import { describe, expect, it } from "vitest";
import { createHmacSessionCodec } from "../hmacSessionCodec";
import {
  createSsoStateCodec,
  DEFAULT_SSO_STATE_TTL_MS,
  type SsoStatePayload,
} from "../ssoStateCodec";

const SECRET = "s".repeat(48);
const NOW = new Date("2026-09-08T00:00:00.000Z");
const PAYLOAD: SsoStatePayload = {
  provider: "google",
  intent: "login",
  redirect: "/settings",
  origin: "/login",
  userId: null,
};

describe("ssoStateCodec", () => {
  it("round-trips the payload and strips the nonce and expiry", async () => {
    const codec = createSsoStateCodec({ sessionSecret: SECRET });
    const state = await codec.issue(PAYLOAD, NOW);
    expect(await codec.verify(state, NOW)).toEqual(PAYLOAD);
  });

  it("issues a distinct state per call for the same payload", async () => {
    const codec = createSsoStateCodec({ sessionSecret: SECRET });
    expect(await codec.issue(PAYLOAD, NOW)).not.toBe(
      await codec.issue(PAYLOAD, NOW),
    );
  });

  it("refuses an expired state", async () => {
    const codec = createSsoStateCodec({ sessionSecret: SECRET });
    const state = await codec.issue(PAYLOAD, NOW);
    expect(
      await codec.verify(
        state,
        new Date(NOW.getTime() + DEFAULT_SSO_STATE_TTL_MS),
      ),
    ).toBeNull();
  });

  it("refuses a tampered body, a wrong secret and garbage", async () => {
    const codec = createSsoStateCodec({ sessionSecret: SECRET });
    const state = await codec.issue(PAYLOAD, NOW);
    const [body, signature] = state.split(".");
    const forged = `${body?.slice(0, -2)}AA.${signature}`;
    expect(await codec.verify(forged, NOW)).toBeNull();
    expect(
      await createSsoStateCodec({ sessionSecret: "x".repeat(48) }).verify(
        state,
        NOW,
      ),
    ).toBeNull();
    expect(await codec.verify("not-a-state", NOW)).toBeNull();
    expect(await codec.verify("", NOW)).toBeNull();
  });

  // △-3: the state key is derived from SESSION_SECRET under a label, so a
  // session token and a state never verify under each other's key even
  // though one secret is deployed.
  it("cannot be verified by the session codec sharing the same secret, nor the reverse", async () => {
    const state = createSsoStateCodec({ sessionSecret: SECRET });
    const session = createHmacSessionCodec({ secret: SECRET });
    const stateValue = await state.issue(PAYLOAD, NOW);
    const sessionToken = await session.issue("user-1", 0, NOW);
    expect(await session.verify(stateValue, NOW)).toBeNull();
    expect(await state.verify(sessionToken, NOW)).toBeNull();
  });

  it("rejects a secret below the session floor", () => {
    expect(() => createSsoStateCodec({ sessionSecret: "short" })).toThrow();
  });
});
