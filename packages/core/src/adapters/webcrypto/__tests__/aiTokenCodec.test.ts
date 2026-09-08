import { describe, expect, it } from "vitest";
import {
  AI_ACCESS_TOKEN_TTL_MS,
  AI_AUTHORIZATION_CODE_TTL_MS,
  AI_REFRESH_TOKEN_TTL_MS,
  createAiTokenCodec,
  isPkceChallenge,
  isPkceVerifier,
  pkceChallengeOf,
} from "../aiTokenCodec";

const SECRET = "a".repeat(48);
const NOW = new Date("2026-09-08T00:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

describe("aiTokenCodec", () => {
  const codec = createAiTokenCodec({ secret: SECRET });

  it("round-trips every kind and enforces each TTL", async () => {
    const access = await codec.issueAccess("u", "c", NOW);
    expect(await codec.verifyAccess(access, NOW)).toMatchObject({
      typ: "access",
      uid: "u",
      cid: "c",
      scope: "ai",
    });
    expect(
      await codec.verifyAccess(access, at(AI_ACCESS_TOKEN_TTL_MS)),
    ).toBeNull();

    const refresh = await codec.issueRefresh("u", "c", "fog_x", NOW);
    expect(
      await codec.verifyRefresh(refresh, at(AI_ACCESS_TOKEN_TTL_MS)),
    ).toMatchObject({
      typ: "refresh",
      client: "fog_x",
    });
    expect(
      await codec.verifyRefresh(refresh, at(AI_REFRESH_TOKEN_TTL_MS)),
    ).toBeNull();

    const payload = {
      jti: "j",
      uid: "u",
      cid: "c",
      client: "fog_x",
      redirect: "http://127.0.0.1:1/cb",
      challenge: "y".repeat(43),
    };
    const code = await codec.issueCode(payload, NOW);
    expect(await codec.verifyCode(code, NOW)).toMatchObject(payload);
    expect(
      await codec.verifyCode(code, at(AI_AUTHORIZATION_CODE_TTL_MS)),
    ).toBeNull();

    const clientId = await codec.issueClientId({
      name: "Claude",
      redirectUris: ["https://a.example/cb"],
      iat: 1,
    });
    expect(clientId.startsWith("fog_")).toBe(true);
    expect(await codec.verifyClientId(clientId)).toEqual({
      name: "Claude",
      redirectUris: ["https://a.example/cb"],
      iat: 1,
    });

    const request = await codec.issueAuthorizeRequest(
      {
        client: clientId,
        name: "Claude",
        redirect: "https://a.example/cb",
        state: null,
        challenge: "y".repeat(43),
        scope: "ai",
      },
      NOW,
    );
    expect(await codec.verifyAuthorizeRequest(request, NOW)).toMatchObject({
      typ: "authz",
      state: null,
    });
  });

  // △-1: one secret, five keys. A value of one kind never verifies as
  // another, even though every kind shares the secret and the encoding.
  it("refuses a value of one kind presented as another", async () => {
    const access = await codec.issueAccess("u", "c", NOW);
    const refresh = await codec.issueRefresh("u", "c", "fog_x", NOW);
    const code = await codec.issueCode(
      {
        jti: "j",
        uid: "u",
        cid: "c",
        client: "x",
        redirect: "r",
        challenge: "ch",
      },
      NOW,
    );
    expect(await codec.verifyRefresh(access, NOW)).toBeNull();
    expect(await codec.verifyAccess(refresh, NOW)).toBeNull();
    expect(await codec.verifyAccess(code, NOW)).toBeNull();
    expect(await codec.verifyCode(access, NOW)).toBeNull();
    expect(await codec.verifyClientId(`fog_${access}`)).toBeNull();
    expect(await codec.verifyAuthorizeRequest(code, NOW)).toBeNull();
  });

  it("refuses tampering, another secret and garbage", async () => {
    const access = await codec.issueAccess("u", "c", NOW);
    const [body, sig] = access.split(".");
    expect(
      await codec.verifyAccess(`${body?.slice(0, -2)}AA.${sig}`, NOW),
    ).toBeNull();
    expect(
      await createAiTokenCodec({ secret: "b".repeat(48) }).verifyAccess(
        access,
        NOW,
      ),
    ).toBeNull();
    expect(await codec.verifyAccess("nope", NOW)).toBeNull();
    expect(await codec.verifyClientId("not-a-client")).toBeNull();
    expect(() => createAiTokenCodec({ secret: "short" })).toThrow();
  });

  it("PKCE S256 matches RFC 7636's appendix B vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(isPkceVerifier(verifier)).toBe(true);
    const challenge = await pkceChallengeOf(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(isPkceChallenge(challenge)).toBe(true);
    expect(isPkceVerifier("too-short")).toBe(false);
    expect(isPkceChallenge("not-43-chars")).toBe(false);
  });
});
