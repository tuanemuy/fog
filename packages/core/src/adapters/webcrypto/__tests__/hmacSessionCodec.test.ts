import { describe, expect, it } from "vitest";
import {
  createHmacSessionCodec,
  DEFAULT_SESSION_TTL_MS,
  MIN_SESSION_SECRET_LENGTH,
} from "../hmacSessionCodec";

const SECRET = "test-session-secret-0123456789abcdef";
const OTHER_SECRET = "other-session-secret-0123456789abcd";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const USER_ID = "01950000-0000-7000-8000-000000000001";
const EPOCH = 3;

const codec = createHmacSessionCodec({ secret: SECRET });

describe("createHmacSessionCodec", () => {
  it("verifies a token it issued", async () => {
    const token = await codec.issue(USER_ID, EPOCH, NOW);
    await expect(codec.verify(token, NOW)).resolves.toEqual({
      userId: USER_ID,
      epoch: EPOCH,
    });
  });

  it("emits `<payload>.<signature>` in base64url", async () => {
    const token = await codec.issue(USER_ID, EPOCH, NOW);
    const parts = token.split(".");

    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("rejects a token whose payload was tampered with", async () => {
    const token = await codec.issue(USER_ID, EPOCH, NOW);
    const [, signature] = token.split(".");
    const forged = btoa(
      JSON.stringify({
        typ: "session",
        uid: "someone-else",
        ep: EPOCH,
        exp: NOW.getTime() + 60_000,
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await expect(
      codec.verify(`${forged}.${signature}`, NOW),
    ).resolves.toBeNull();
  });

  it("rejects a token whose signature was tampered with", async () => {
    const token = await codec.issue(USER_ID, EPOCH, NOW);
    const [payload, signature] = token.split(".");
    const flipped = `${signature?.slice(0, -1)}${signature?.endsWith("A") ? "B" : "A"}`;

    await expect(
      codec.verify(`${payload}.${flipped}`, NOW),
    ).resolves.toBeNull();
  });

  it("rejects a token issued under a different secret", async () => {
    const other = createHmacSessionCodec({ secret: OTHER_SECRET });
    const token = await other.issue(USER_ID, EPOCH, NOW);

    await expect(codec.verify(token, NOW)).resolves.toBeNull();
  });

  it("rejects an expired token and accepts it up to the last millisecond", async () => {
    const shortLived = createHmacSessionCodec({ secret: SECRET, ttlMs: 1_000 });
    const token = await shortLived.issue(USER_ID, EPOCH, NOW);

    await expect(
      shortLived.verify(token, new Date(NOW.getTime() + 999)),
    ).resolves.toEqual({ userId: USER_ID, epoch: EPOCH });
    await expect(
      shortLived.verify(token, new Date(NOW.getTime() + 1_000)),
    ).resolves.toBeNull();
  });

  it("defaults the TTL to seven days", async () => {
    const token = await codec.issue(USER_ID, EPOCH, NOW);

    await expect(
      codec.verify(token, new Date(NOW.getTime() + DEFAULT_SESSION_TTL_MS - 1)),
    ).resolves.toEqual({ userId: USER_ID, epoch: EPOCH });
    await expect(
      codec.verify(token, new Date(NOW.getTime() + DEFAULT_SESSION_TTL_MS)),
    ).resolves.toBeNull();
  });

  it.each([
    ["empty string", ""],
    ["no separator", "abcdef"],
    ["too many segments", "a.b.c"],
    ["empty signature", "abcdef."],
    ["not base64", "!!!.???"],
  ])("rejects a malformed token: %s", async (_label, token) => {
    await expect(codec.verify(token, NOW)).resolves.toBeNull();
  });
});

// Every token this codec ever signs is only as unforgeable as the key it
// was built with, and the factory is the last place that can refuse. A
// deployment whose `SESSION_SECRET` is a placeholder must fail to build a
// codec rather than issue forgeable sessions, so the refusing side is
// walked here alongside the boundary that must still be accepted.
describe("createHmacSessionCodec argument validation", () => {
  it.each([
    ["an empty secret", ""],
    ["a one-character secret", "x"],
    [
      "one character below the floor",
      "a".repeat(MIN_SESSION_SECRET_LENGTH - 1),
    ],
  ])("refuses to build a codec from %s", (_label, secret) => {
    expect(() => createHmacSessionCodec({ secret })).toThrow(/at least/);
  });

  it("accepts a secret of exactly the floor, so the check is `<` and not `<=`", async () => {
    const shortest = "a".repeat(MIN_SESSION_SECRET_LENGTH);
    const floorCodec = createHmacSessionCodec({ secret: shortest });

    const token = await floorCodec.issue(USER_ID, EPOCH, NOW);
    await expect(floorCodec.verify(token, NOW)).resolves.toEqual({
      userId: USER_ID,
      epoch: EPOCH,
    });
  });
});

// A session token and an AI client token are signed with different keys and
// carry different audience tags. Either mechanism alone would do on a good day;
// the tag is what still holds if a deployment ever reuses a key.
describe("payload validation", () => {
  async function signPayload(payload: unknown): Promise<string> {
    const encoder = new TextEncoder();
    const encoded = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(encoded),
    );
    const encodedSignature = btoa(
      String.fromCharCode(...new Uint8Array(signature)),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `${encoded}.${encodedSignature}`;
  }

  const exp = NOW.getTime() + 60_000;

  // Reading a missing `ep` as epoch 0 would let a token minted before epochs
  // existed survive the revocation that was supposed to kill it. One extra
  // sign-in for everybody is recoverable; a session outliving its revocation
  // is not.
  it("rejects a validly signed token with no epoch", async () => {
    const token = await signPayload({ typ: "session", uid: USER_ID, exp });
    await expect(codec.verify(token, NOW)).resolves.toBeNull();
  });

  it("rejects a validly signed token with no audience tag", async () => {
    const token = await signPayload({ uid: USER_ID, ep: EPOCH, exp });
    await expect(codec.verify(token, NOW)).resolves.toBeNull();
  });

  it("rejects a validly signed token carrying another audience", async () => {
    const token = await signPayload({
      typ: "aiClient",
      uid: USER_ID,
      ep: EPOCH,
      exp,
    });
    await expect(codec.verify(token, NOW)).resolves.toBeNull();
  });

  it("carries the epoch it was issued with", async () => {
    const token = await codec.issue(USER_ID, 42, NOW);
    await expect(codec.verify(token, NOW)).resolves.toEqual({
      userId: USER_ID,
      epoch: 42,
    });
  });
});
