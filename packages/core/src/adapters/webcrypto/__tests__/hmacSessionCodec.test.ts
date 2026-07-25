import { describe, expect, it } from "vitest";
import {
  createHmacSessionCodec,
  DEFAULT_SESSION_TTL_MS,
} from "../hmacSessionCodec";

const SECRET = "test-session-secret-0123456789abcdef";
const OTHER_SECRET = "other-session-secret-0123456789abcd";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const USER_ID = "01950000-0000-7000-8000-000000000001";

const codec = createHmacSessionCodec({ secret: SECRET });

describe("createHmacSessionCodec", () => {
  it("verifies a token it issued", async () => {
    const token = await codec.issue(USER_ID, NOW);
    await expect(codec.verify(token, NOW)).resolves.toEqual({
      userId: USER_ID,
    });
  });

  it("emits `<payload>.<signature>` in base64url", async () => {
    const token = await codec.issue(USER_ID, NOW);
    const parts = token.split(".");

    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("rejects a token whose payload was tampered with", async () => {
    const token = await codec.issue(USER_ID, NOW);
    const [, signature] = token.split(".");
    const forged = btoa(
      JSON.stringify({ uid: "someone-else", exp: NOW.getTime() + 60_000 }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await expect(
      codec.verify(`${forged}.${signature}`, NOW),
    ).resolves.toBeNull();
  });

  it("rejects a token whose signature was tampered with", async () => {
    const token = await codec.issue(USER_ID, NOW);
    const [payload, signature] = token.split(".");
    const flipped = `${signature?.slice(0, -1)}${signature?.endsWith("A") ? "B" : "A"}`;

    await expect(
      codec.verify(`${payload}.${flipped}`, NOW),
    ).resolves.toBeNull();
  });

  it("rejects a token issued under a different secret", async () => {
    const other = createHmacSessionCodec({ secret: OTHER_SECRET });
    const token = await other.issue(USER_ID, NOW);

    await expect(codec.verify(token, NOW)).resolves.toBeNull();
  });

  it("rejects an expired token and accepts it up to the last millisecond", async () => {
    const shortLived = createHmacSessionCodec({ secret: SECRET, ttlMs: 1_000 });
    const token = await shortLived.issue(USER_ID, NOW);

    await expect(
      shortLived.verify(token, new Date(NOW.getTime() + 999)),
    ).resolves.toEqual({ userId: USER_ID });
    await expect(
      shortLived.verify(token, new Date(NOW.getTime() + 1_000)),
    ).resolves.toBeNull();
  });

  it("defaults the TTL to seven days", async () => {
    const token = await codec.issue(USER_ID, NOW);

    await expect(
      codec.verify(token, new Date(NOW.getTime() + DEFAULT_SESSION_TTL_MS - 1)),
    ).resolves.toEqual({ userId: USER_ID });
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
